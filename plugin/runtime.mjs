import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, createWriteStream } from 'node:fs'
import { readFile, rename, rm, lstat, realpath } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { safeDirectory, hashFile, extractVerified, validateInstalled, safeEntry } from './archive.mjs'
import { VERSION } from '../version.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const packageRoot = resolve(here, existsSync(join(here, '../package.json')) ? '..' : '../..')
const processes = new Map()
const installations = new Map()
const LEGACY_VERSIONS = ['0.1.0']

export class RuntimeManager {
  constructor({ home = process.env.DSH_HOME || join(homedir(), '.seal-harness'), accountId, signal, onLog = () => {}, manifest, legacyManifests, fetchImpl = fetch, renameImpl = rename, spawnImpl = spawn } = {}) {
    if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('缺少当前账号。')
    this.home = resolve(home)
    this.accountId = accountId
    this.accountHash = createHash('sha256').update(accountId).digest('hex').slice(0, 16)
    this.dataDirectory = join(this.home, 'ez-tree/accounts', this.accountHash)
    this.installDirectory = join(this.dataDirectory, 'runtime', VERSION, `${process.platform}-${process.arch}`)
    this.signal = signal
    this.onLog = onLog
    this.manifest = manifest
    this.legacyManifests = legacyManifests
    this.fetch = fetchImpl
    this.rename = renameImpl
    this.spawn = spawnImpl
  }
  runtimeDirectory(version) {
    if (version !== VERSION && !LEGACY_VERSIONS.includes(version)) throw new Error('未知的受管理应用版本。')
    return join(this.dataDirectory, 'runtime', version, `${process.platform}-${process.arch}`)
  }
  async release(version = VERSION) {
    this.runtimeDirectory(version)
    const manifest = (version === VERSION ? this.manifest : this.legacyManifests?.[version])
      ?? JSON.parse(await readFile(join(packageRoot, version === VERSION ? 'releases/runtime.json' : `releases/legacy/${version}.json`), 'utf8'))
    if (manifest.version !== version || manifest.appId !== 'com.asun-labs.ez-tree') throw new Error('应用发布清单版本无效。')
    const release = manifest.platforms[`${process.platform}-${process.arch}`]
    if (!release) return null
    const asset = `dsh-ez-tree-${version}-${process.platform}-${process.arch}.zip`
    if (release.url !== `https://github.com/asun-labs/dsh-ez-tree/releases/download/v${version}/${asset}` || !/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > 1024 ** 3 || !Array.isArray(release.files)) throw new Error('应用发布清单无效。')
    safeEntry(release.executable)
    if (!release.mcp || release.mcp.env?.ELECTRON_RUN_AS_NODE !== '1' || Object.keys(release.mcp.env).length !== 1) throw new Error('MCP 启动清单无效。')
    safeEntry(release.mcp.entry)
    if (!release.files.some(file => file.path === release.mcp.entry)) throw new Error('MCP 入口未列入文件校验清单。')
    return release
  }
  async selectedRuntime(targetRelease) {
    const errors = []
    for (const version of [VERSION, ...LEGACY_VERSIONS]) {
      const directory = this.runtimeDirectory(version)
      if (!existsSync(directory)) continue
      const release = version === VERSION ? targetRelease : await this.release(version)
      if (!release) continue
      try {
        const manifest = await validateInstalled(directory, release)
        if (manifest.version !== version || manifest.name !== 'dsh-ez-tree-desktop') throw new Error('应用身份不匹配。')
        return { runtime: { version, directory, release }, error: errors.join('；') || undefined }
      } catch (error) { errors.push(`${version}：${error.message}`) }
    }
    return { runtime: null, error: errors.join('；') || undefined }
  }
  async status() {
    const release = await this.release()
    const selected = await this.selectedRuntime(release)
    return { supported: Boolean(release || selected.runtime), available: Boolean(release), installed: Boolean(selected.runtime),
      version: selected.runtime?.version ?? VERSION, targetVersion: VERSION,
      updateAvailable: Boolean(release && selected.runtime && selected.runtime.version !== VERSION),
      running: Boolean(processes.get(this.dataDirectory)), dataDirectory: this.dataDirectory,
      ...(selected.error ? { error: selected.error } : {}) }
  }
  async install() {
    const current = installations.get(this.installDirectory)
    if (current) { await current; return this.status() }
    const pending = this.installRuntime()
    installations.set(this.installDirectory, pending)
    try { await pending; return this.status() }
    finally { installations.delete(this.installDirectory) }
  }
  async installRuntime() {
    this.signal?.throwIfAborted()
    const release = await this.release()
    if (!release) throw new Error('当前平台尚无已验证的 EZ-Tree 桌面发布包。')
    const status = await this.status()
    if (status.installed && status.version === VERSION) return
    if (processes.has(this.dataDirectory)) throw new Error('请先关闭正在运行的 EZ-Tree 再升级或重新安装。')
    const parent = dirname(this.installDirectory)
    await safeDirectory(parent)
    const stage = join(parent, `.staging-${randomUUID()}`)
    const archive = stage + '.zip'
    const backup = stage + '.backup'
    let replaced = false
    try {
      this.onLog('正在下载已固定版本的桌面应用…')
      const response = await this.fetch(release.url, { signal: this.signal })
      if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}），请重试。`)
      let bytes = 0
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length
        callback(bytes > release.bytes ? new Error('下载文件超过发布清单大小。') : null, chunk)
      } }), createWriteStream(archive, { flags: 'wx' }), { signal: this.signal })
      if (bytes !== release.bytes || await hashFile(archive) !== release.sha256) throw new Error('桌面包 SHA-256 校验失败，未安装。')
      this.onLog('正在校验并安装桌面应用…')
      await extractVerified(archive, stage, release.files, this.signal)
      const identity = await validateInstalled(stage, release)
      if (identity.name !== 'dsh-ez-tree-desktop' || identity.version !== VERSION) throw new Error('安装包产品身份无效。')
      this.signal?.throwIfAborted()
      if (existsSync(this.installDirectory)) { await this.rename(this.installDirectory, backup); replaced = true }
      try { await this.rename(stage, this.installDirectory) }
      catch (error) {
        if (replaced) {
          try { await this.rename(backup, this.installDirectory) }
          catch (restore) { throw new AggregateError([error, restore], `安装替换与恢复失败，旧版保留在 ${backup}。请恢复该目录后重试。`) }
        }
        throw error
      }
      this.onLog('EZ-Tree 安装完成。')
    } finally {
      const cleanup = existsSync(this.installDirectory) ? [stage, archive, backup] : [stage, archive]
      for (const path of cleanup) {
        if (dirname(path) !== parent || !path.startsWith(join(parent, '.staging-'))) throw new Error('临时目录边界无效。')
        await rm(path, { recursive: true, force: true })
      }
    }
  }
  async descriptor() {
    const selected = await this.selectedRuntime(await this.release())
    this.signal?.throwIfAborted()
    if (!selected.runtime) throw new Error(selected.error || '请先安装 EZ-Tree 桌面应用。')
    await safeDirectory(this.dataDirectory)
    const { version, directory, release } = selected.runtime
    return { command: join(directory, release.executable), args: [join(directory, release.mcp.entry), '--account', this.accountId],
      env: { ...release.mcp.env, DSH_HOME: this.home }, cwd: this.dataDirectory, version }
  }
  async launch() {
    this.signal?.throwIfAborted()
    if (processes.has(this.dataDirectory)) return this.status()
    if (installations.has(this.installDirectory)) throw new Error('应用正在安装，请稍后重试。')
    const descriptor = await this.descriptor()
    this.signal?.throwIfAborted()
    if (installations.has(this.installDirectory)) throw new Error('应用正在安装，请稍后重试。')
    const release = await this.release(descriptor.version)
    const directory = this.runtimeDirectory(descriptor.version)
    const command = join(directory, release.executable)
    const ready = join(this.dataDirectory, 'ready.json')
    await rm(ready, { force: true })
    this.signal?.throwIfAborted()
    const environment = { ...process.env, DSH_HOME: this.home }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = this.spawn(command, ['--account', this.accountId, '--ready-file', ready], { cwd: descriptor.cwd, env: environment, stdio: 'ignore', windowsHide: true })
    const record = { child, installDirectory: directory, version: descriptor.version }
    processes.set(this.dataDirectory, record)
    let failure
    child.once('error', error => { failure = error; if (processes.get(this.dataDirectory) === record) processes.delete(this.dataDirectory) })
    child.once('exit', () => { if (processes.get(this.dataDirectory) === record) processes.delete(this.dataDirectory) })
    const abort = () => child.kill()
    this.signal?.addEventListener('abort', abort, { once: true })
    try {
      const deadline = Date.now() + 90000
      while (!existsSync(ready)) {
        this.signal?.throwIfAborted()
        if (failure) throw failure
        if (child.exitCode !== null || child.signalCode || !processes.has(this.dataDirectory)) throw new Error('EZ-Tree 在就绪前退出。')
        if (Date.now() > deadline) throw new Error('EZ-Tree 启动超时。')
        await new Promise(ok => setTimeout(ok, 200))
      }
      const marker = JSON.parse(await readFile(ready, 'utf8'))
      const executable = await realpath(command)
      const runningExecutable = typeof marker.executable === 'string' ? await realpath(marker.executable) : ''
      if (marker.version !== descriptor.version || marker.pid !== child.pid || runningExecutable.toLowerCase() !== executable.toLowerCase()) throw new Error('运行中的应用身份不匹配。')
      return this.status()
    } catch (error) { child.kill(); throw error }
    finally { this.signal?.removeEventListener('abort', abort) }
  }
  async stop() {
    const record = processes.get(this.dataDirectory)
    if (record) {
      const exit = new Promise(ok => record.child.once('exit', ok))
      record.child.kill()
      await Promise.race([exit, new Promise((_, fail) => setTimeout(() => fail(new Error('应用仍在退出，请稍后重试。')), 10000).unref())])
    }
    return this.status()
  }
  async uninstall() {
    this.signal?.throwIfAborted()
    if (processes.has(this.dataDirectory)) throw new Error('请先关闭 EZ-Tree 再卸载。')
    if (installations.has(this.installDirectory)) throw new Error('应用正在安装，请稍后重试。')
    for (const version of [VERSION, ...LEGACY_VERSIONS]) {
      const directory = this.runtimeDirectory(version)
      if (!existsSync(directory) || !await this.release(version)) continue
      await safeDirectory(dirname(directory))
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('应用目录不能是链接。')
      await rm(directory, { recursive: true })
    }
    return this.status()
  }
}
