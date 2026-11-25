import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readFile, rename, writeFile, rm, realpath } from 'node:fs/promises'
import { safeDirectory } from './archive.mjs'
import { presets as bundledPresets } from './presets.mjs'
import { mergeOptions, checkComplexity } from '../app/options.js'
import { outputName, saveExport } from '../desktop/paths.mjs'
import { VERSION } from '../version.mjs'

const clone = value => structuredClone(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const optionsDigest = options => hash(JSON.stringify(canonical(options)))

export class ProjectError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const error = (code, message) => new ProjectError(code, message)

/** 一个账号/会话只有一个已提交项目；所有写操作等待真实渲染确认后才提交。 */
export class ProjectStore {
  constructor({ home = process.env.DSH_HOME || join(homedir(), '.seal-harness'), presets = bundledPresets,
    renderTimeoutMs = 60000, watchTimeoutMs = 20000 } = {}) {
    this.home = resolve(home)
    this.presets = presets
    this.renderTimeoutMs = renderTimeoutMs
    this.watchTimeoutMs = watchTimeoutMs
    this.entries = new Map()
    this.disposed = false
  }
  async entry(scope, sessionId) {
    if (this.disposed) throw error('disposed', '编辑服务已关闭。')
    if (!scope || typeof scope.accountId !== 'string' || !scope.accountId || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || sessionId.includes('\0')) throw error('invalidContext', '缺少有效账号或会话身份。')
    const account = hash(scope.accountId).slice(0, 16), session = hash(sessionId).slice(0, 24)
    const key = `${account}:${session}`
    let entry = this.entries.get(key)
    if (!entry) {
      const path = join(this.home, 'ez-tree/accounts', account, 'sessions', session, 'project.json')
      entry = { key, path, sessionId, epoch: scope.epoch ?? 0, generation: 0, cursor: 0, document: null,
        pending: null, watchers: new Set(), queue: Promise.resolve(), lastError: null }
      // 同步登记 loading promise，防止两个并发读取创建两份状态队列。
      this.entries.set(key, entry)
      entry.loaded = (async () => {
        try {
          const document = JSON.parse(await readFile(path, 'utf8'))
          if (document.schemaVersion !== 1 || document.sessionId !== sessionId || typeof document.projectId !== 'string'
            || !Number.isSafeInteger(document.revision) || document.revision < 0
            || !Object.hasOwn(this.presets, document.preset)
            || optionsDigest(document.options) !== document.optionsDigest) throw error('invalidProject', '会话项目数据损坏，请恢复参数 JSON。')
          mergeOptions(this.presets[document.preset], document.options)
          checkComplexity(document.options)
          entry.document = document
          entry.cursor = 1
        } catch (failure) { if (failure.code !== 'ENOENT') throw failure }
      })()
    }
    await entry.loaded
    if (entry.epoch !== (scope.epoch ?? 0)) {
      this.cancelEntry(entry, error('identityChanged', '账号会话已变化，请重新打开编辑器。'))
      entry.epoch = scope.epoch ?? 0
    }
    return entry
  }
  snapshot(entry) {
    return clone({ cursor: entry.cursor, project: entry.document, ...(entry.lastError ? { error: entry.lastError } : {}), command: entry.pending ? {
      operationId: entry.pending.id, kind: entry.pending.kind, project: entry.pending.project,
      ...(entry.pending.format ? { format: entry.pending.format } : {}),
    } : null })
  }
  notify(entry) {
    entry.cursor++
    for (const watcher of [...entry.watchers]) watcher.resolve(this.snapshot(entry))
  }
  async read(scope, sessionId) { return this.snapshot(await this.entry(scope, sessionId)) }
  async watch(scope, sessionId, afterCursor = 0, signal) {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw error('invalidCursor', '无效的编辑器订阅游标。')
    signal?.throwIfAborted()
    const entry = await this.entry(scope, sessionId)
    if (entry.cursor !== afterCursor) return this.snapshot(entry)
    return new Promise((resolveWait, rejectWait) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); entry.watchers.delete(watcher) }
      const watcher = { resolve: value => { cleanup(); resolveWait(value) }, reject: reason => { cleanup(); rejectWait(reason) } }
      const abort = () => watcher.reject(signal.reason ?? error('cancelled', '编辑器订阅已取消。'))
      const timer = setTimeout(() => watcher.resolve(this.snapshot(entry)), this.watchTimeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      entry.watchers.add(watcher)
      if (signal?.aborted) abort()
    })
  }
  enqueue(entry, operation) {
    const generation = entry.generation
    const pending = entry.queue.then(() => {
      this.assertCurrent(entry, generation)
      return operation(generation)
    })
    entry.queue = pending.catch(() => {})
    return pending
  }
  assertCurrent(entry, generation, signal) {
    signal?.throwIfAborted()
    if (this.disposed || entry.generation !== generation) throw error('cancelled', '编辑操作已取消。')
  }
  async persist(entry, document) {
    await safeDirectory(dirname(entry.path))
    const temporary = join(dirname(entry.path), `.project-${randomUUID()}.tmp`)
    try { await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, entry.path) }
    finally { await rm(temporary, { force: true }) }
  }
  async command(entry, kind, project, { format, signal } = {}) {
    signal?.throwIfAborted()
    if (entry.pending) throw error('busy', '编辑器正在处理另一个操作。')
    return new Promise((resolveCommand, rejectCommand) => {
      const finish = (failure, result) => {
        if (entry.pending?.id !== operation.id) return
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        entry.pending = null
        if (failure) { entry.lastError = failure.message; this.notify(entry); rejectCommand(failure) }
        else resolveCommand(result)
      }
      const operation = { id: randomUUID(), kind, project: clone(project), format,
        resolve: result => finish(null, result), reject: failure => finish(failure) }
      const abort = () => operation.reject(signal.reason ?? error('cancelled', '编辑操作已取消。'))
      const timer = setTimeout(() => operation.reject(error('rendererUnavailable', '没有收到三维面板的渲染确认，请在当前会话打开编辑器后重试。')), this.renderTimeoutMs)
      entry.pending = operation
      entry.lastError = null
      signal?.addEventListener('abort', abort, { once: true })
      this.notify(entry)
      if (signal?.aborted) abort()
    })
  }
  async open(scope, sessionId, { workspace, signal } = {}) {
    if (typeof workspace !== 'string' || !workspace) throw error('workspaceUnavailable', '当前会话没有可用工作目录。')
    const entry = await this.entry(scope, sessionId)
    return this.enqueue(entry, async generation => {
      this.assertCurrent(entry, generation, signal)
      const directory = await realpath(resolve(workspace))
      const previous = entry.document
      let candidate
      if (!previous) {
        const options = clone(this.presets['Ash Medium'])
        candidate = { schemaVersion: 1, projectId: randomUUID(), sessionId, revision: 0, preset: 'Ash Medium', options,
          optionsDigest: optionsDigest(options), engineVersion: VERSION, workspace: directory, updatedAt: new Date().toISOString() }
      } else candidate = { ...previous, workspace: directory }
      try {
        const metrics = await this.command(entry, 'apply', candidate, { signal })
        this.assertCurrent(entry, generation, signal)
        await this.persist(entry, candidate)
        this.assertCurrent(entry, generation, signal)
        entry.document = candidate
        this.notify(entry)
        return { project: clone(candidate), metrics, rendered: true, presets: Object.keys(this.presets) }
      } catch (failure) {
        if (previous) await this.persist(entry, previous)
        else await rm(entry.path, { force: true })
        entry.document = previous
        entry.lastError = failure.message
        this.notify(entry)
        throw failure
      }
    })
  }
  async edit(scope, sessionId, { expectedRevision, preset, options = {}, signal } = {}) {
    const entry = await this.entry(scope, sessionId)
    return this.enqueue(entry, async generation => {
      this.assertCurrent(entry, generation, signal)
      const previous = entry.document
      if (!previous) throw error('projectMissing', '请先在当前会话调用树木编辑技能。')
      if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw error('revisionConflict', '参数已被另一操作更新，已保留最新项目，请读取后重试。')
      const selected = preset ?? previous.preset
      if (!Object.hasOwn(this.presets, selected)) throw error('invalidPreset', '未知树木预设。')
      const nextOptions = mergeOptions(preset === undefined ? previous.options : this.presets[selected], options)
      checkComplexity(nextOptions)
      const next = { ...previous, preset: selected, options: nextOptions, optionsDigest: optionsDigest(nextOptions),
        revision: previous.revision + 1, engineVersion: VERSION, updatedAt: new Date().toISOString() }
      try {
        const metrics = await this.command(entry, 'apply', next, { signal })
        this.assertCurrent(entry, generation, signal)
        await this.persist(entry, next)
        this.assertCurrent(entry, generation, signal)
        entry.document = next
        this.notify(entry)
        return { project: clone(next), metrics, rendered: true }
      } catch (failure) {
        await this.persist(entry, previous)
        entry.document = previous
        entry.lastError = failure.message
        this.notify(entry)
        throw failure
      }
    })
  }
  async ack(scope, sessionId, { operationId, revision, optionsDigest: digest, metrics } = {}) {
    const entry = await this.entry(scope, sessionId), pending = entry.pending
    if (!pending || pending.id !== operationId || pending.kind !== 'apply') throw error('staleOperation', '渲染操作已结束。')
    if (pending.project.revision !== revision || pending.project.optionsDigest !== digest) throw error('revisionConflict', '渲染结果与请求项目不一致。')
    if (!metrics || !Number.isFinite(metrics.vertexCount) || metrics.vertexCount < 1 || metrics.vertexCount > 2_000_000
      || !Number.isFinite(metrics.triangleCount) || metrics.triangleCount < 1) throw error('invalidRender', '三维面板没有返回有效模型。')
    pending.resolve(clone(metrics))
    return { accepted: true }
  }
  async fail(scope, sessionId, operationId, message) {
    const entry = await this.entry(scope, sessionId)
    if (!entry.pending || entry.pending.id !== operationId) return { accepted: false }
    entry.pending.reject(error('rendererFailed', String(message || '三维面板执行失败。').slice(0, 1000)))
    return { accepted: true }
  }
  async export(scope, sessionId, { format, name, signal } = {}) {
    const filename = outputName(format, name)
    const entry = await this.entry(scope, sessionId)
    return this.enqueue(entry, async generation => {
      this.assertCurrent(entry, generation, signal)
      if (!entry.document) throw error('projectMissing', '请先在当前会话打开树木编辑器。')
      const pending = this.command(entry, 'export', entry.document, { format, signal })
      entry.pending.filename = filename
      return pending
    })
  }
  async upload(scope, sessionId, operationId, input) {
    const entry = await this.entry(scope, sessionId), pending = entry.pending
    if (!pending || pending.kind !== 'export' || pending.id !== operationId) throw error('staleOperation', '导出操作已结束。')
    const bytes = Buffer.from(input)
    if (!bytes.length || bytes.length > 128 * 1024 * 1024) throw error('invalidExport', '导出文件为空或超过限制。')
    const format = pending.format
    if (format === 'glb') {
      if (bytes.length < 28 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2
        || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw error('invalidExport', '导出的 GLB 数据无效。')
      const size = bytes.readUInt32LE(12)
      if (size < 4 || 20 + size > bytes.length) throw error('invalidExport', '导出的 GLB JSON 数据不完整。')
      let scene
      try { scene = JSON.parse(bytes.toString('utf8', 20, 20 + size).trim()) } catch { throw error('invalidExport', '导出的 GLB 场景无效。') }
      if (scene.asset?.version !== '2.0' || !Array.isArray(scene.meshes) || !scene.meshes.length) throw error('invalidExport', '导出的 GLB 不含实际模型。')
    }
    if (format === 'png' && (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)
      || bytes.readUInt32BE(16) > 16384 || bytes.readUInt32BE(20) > 16384 || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND'))
      throw error('invalidExport', '导出的 PNG 数据无效。')
    if (format === 'json' && optionsDigest(JSON.parse(bytes.toString('utf8'))) !== pending.project.optionsDigest) throw error('invalidExport', '导出的参数 JSON 与当前项目不一致。')
    const generation = entry.generation
    const workspace = await realpath(pending.project.workspace)
    const output = join(workspace, 'models', 'ez-tree')
    await safeDirectory(output)
    this.assertCurrent(entry, generation)
    if (entry.pending !== pending) throw error('staleOperation', '导出已取消。')
    const artifact = { ...await saveExport(output, format, pending.filename, bytes.toString('base64')),
      revision: pending.project.revision, optionsDigest: pending.project.optionsDigest, seed: pending.project.options.seed }
    try {
      this.assertCurrent(entry, generation)
      if (entry.pending !== pending) throw error('staleOperation', '导出在文件保存期间已取消。')
    }
    catch (failure) { await rm(artifact.path, { force: true }); throw failure }
    pending.resolve(artifact)
    this.notify(entry)
    return artifact
  }
  cancelEntry(entry, reason) {
    entry.generation++
    entry.pending?.reject(reason)
    for (const watcher of [...entry.watchers]) watcher.reject(reason)
  }
  cancelAll(reason = error('identityChanged', '账号或连接已变化，请重新打开编辑器。')) {
    for (const entry of this.entries.values()) this.cancelEntry(entry, reason)
  }
  dispose() { this.disposed = true; this.cancelAll(error('disposed', '编辑器插件已卸载。')) }
}
