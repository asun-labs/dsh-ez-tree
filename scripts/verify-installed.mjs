import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { RuntimeManager } from '../plugin/runtime.mjs'
import { extractVerified, hashFile } from '../plugin/archive.mjs'
import { verifyDesktop } from './verify-desktop.mjs'

const root = resolve(import.meta.dirname, '..')
const home = join(root, '.build/installed-home')
const manifest = JSON.parse(await readFile(join(root, 'releases/runtime.json'), 'utf8'))
const release = manifest.platforms[`${process.platform}-${process.arch}`]
if (!release) throw new Error('当前平台没有经过打包验收的发布物。')
const archive = join(root, 'dist', release.url.split('/').at(-1))
const manager = new RuntimeManager({ home, accountId: 'installed-verification', manifest,
  fetchImpl: async () => new Response(Readable.toWeb(createReadStream(archive))),
  spawnImpl: (command, args, options) => spawn(command, [...args, '--no-window'], options), onLog: message => console.log(message) })
const legacyIndex = process.argv.indexOf('--legacy-archive')
let oldDescriptor
if (legacyIndex >= 0) {
  const legacyArchive = resolve(process.argv[legacyIndex + 1] || '')
  const legacy = JSON.parse(await readFile(join(root, 'releases/legacy/0.1.0.json'), 'utf8'))
  const old = legacy.platforms[`${process.platform}-${process.arch}`]
  assert.ok(old, '此平台没有受信历史发布物。')
  assert.equal(await hashFile(legacyArchive), old.sha256)
  const oldDirectory = manager.runtimeDirectory('0.1.0')
  await extractVerified(legacyArchive, oldDirectory, old.files)
  oldDescriptor = await manager.descriptor()
  assert.equal(oldDescriptor.version, '0.1.0')
  assert.equal((await manager.status()).updateAvailable, true)
  await mkdir(join(manager.dataDirectory, 'projects'), { recursive: true })
  await writeFile(join(manager.dataDirectory, 'projects/legacy-project.json'), '{"seed":97531}')
}
console.log('正在从精确发行 ZIP 安装到隔离账号目录。')
assert.equal((await manager.install()).installed, true)
const descriptor = await manager.descriptor()
assert.equal(descriptor.version, manifest.version)
if (oldDescriptor) {
  assert.notEqual(descriptor.command, oldDescriptor.command)
  assert.equal(JSON.parse(await readFile(join(manager.dataDirectory, 'projects/legacy-project.json'), 'utf8')).seed, 97531)
  assert.ok((await readFile(oldDescriptor.command)).length > 0)
}
const desktop = await verifyDesktop(descriptor.command)
await writeFile(join(manager.dataDirectory, 'preserved-project.json'), '{"seed":31415}')
await manager.launch()
assert.equal((await manager.status()).running, true)
await manager.stop()
assert.equal((await manager.status()).running, false)
await manager.launch()
assert.equal((await manager.status()).running, true)
await manager.stop()
await manager.uninstall()
assert.equal((await manager.status()).installed, false)
assert.equal(JSON.parse(await readFile(join(manager.dataDirectory, 'preserved-project.json'), 'utf8')).seed, 31415)
const report = { version: manifest.version, verifiedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  install: true, realDesktop: true, reopen: true, close: true, uninstall: true, dataPreserved: true,
  archiveSha256: release.sha256, desktop, hiddenWindows: true,
  legacyUpgradeVerified: Boolean(oldDescriptor), oldMcpPathPreserved: Boolean(oldDescriptor) }
await mkdir(join(root, '.build'), { recursive: true })
await writeFile(join(root, '.build/installed-verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log('已安装实例完整验收通过，报告：.build/installed-verification.json')
