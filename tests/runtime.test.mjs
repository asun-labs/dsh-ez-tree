import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, rename, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { RuntimeManager } from '../plugin/runtime.mjs'
import { safeDirectory, safeEntry, validateInstalled, extractVerified } from '../plugin/archive.mjs'
import { VERSION } from '../version.mjs'
import { EventEmitter } from 'node:events'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, version = VERSION) {
  const temporary = await realpath(tmpdir())
  const root = await mkdtemp(join(temporary, 'ez-tree-test-'))
  t.after(async () => { assert.ok(resolve(root).startsWith(temporary + '\\') || resolve(root).startsWith(temporary + '/')); await rm(root, { recursive: true, force: true }) })
  const content = { 'EZ-Tree.exe': `test-runtime-${version}`, 'resources/app/package.json': JSON.stringify({ name: 'dsh-ez-tree-desktop', version }), 'resources/app/lib/mcp/cli.mjs': `test-mcp-launcher-${version}` }
  const input = join(root, 'input')
  await safeDirectory(input)
  for (const [path, data] of Object.entries(content)) { await safeDirectory(join(input, path, '..')); await writeFile(join(input, path), data) }
  const archive = join(root, 'runtime.zip')
  const source = 'import zipfile,os,sys\nwith zipfile.ZipFile(sys.argv[2],"w",compression=zipfile.ZIP_DEFLATED) as z:\n for base,dirs,files in os.walk(sys.argv[1]):\n  for f in files:\n   p=os.path.join(base,f);z.write(p,os.path.relpath(p,sys.argv[1]).replace(os.sep,"/"))'
  execFileSync(process.platform === 'win32' ? 'py' : 'python3', [...(process.platform === 'win32' ? ['-3'] : []), '-c', source, input, archive], { windowsHide: true })
  const bytes = await readFile(archive)
  const release = { url: `https://github.com/asun-labs/dsh-ez-tree/releases/download/v${version}/dsh-ez-tree-${version}-${process.platform}-${process.arch}.zip`, sha256: sha(bytes), bytes: bytes.length, executable: 'EZ-Tree.exe',
    mcp: { entry: 'resources/app/lib/mcp/cli.mjs', env: { ELECTRON_RUN_AS_NODE: '1' } },
    files: Object.entries(content).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: sha(value) })) }
  const manifest = { appId: 'com.asun-labs.ez-tree', version, platforms: { [`${process.platform}-${process.arch}`]: release } }
  const manager = new RuntimeManager({ home: join(root, 'home'), accountId: 'test-account', manifest, fetchImpl: async () => new Response(bytes) })
  return { root, manager, bytes, release, manifest, archive }
}

test('trusted archive installs into account directory, detects tampering and preserves user data on uninstall', async t => {
  const { manager } = await fixture(t)
  assert.equal((await manager.status()).installed, false)
  assert.equal((await manager.install()).installed, true)
  const descriptor = await manager.descriptor()
  assert.ok(descriptor.command.startsWith(manager.dataDirectory))
  await writeFile(join(manager.dataDirectory, 'project.json'), '{"seed":42}')
  await writeFile(descriptor.command, 'tampered')
  assert.equal((await manager.status()).installed, false)
  await assert.rejects(manager.descriptor(), /损坏/)
  assert.equal((await manager.install()).installed, true)
  assert.equal((await manager.uninstall()).installed, false)
  assert.equal(await readFile(join(manager.dataDirectory, 'project.json'), 'utf8'), '{"seed":42}')
})

test('hash failure and cancellation do not publish an installation', async t => {
  const { manager, manifest, bytes } = await fixture(t)
  manager.fetch = async () => new Response(Buffer.alloc(bytes.length))
  await assert.rejects(manager.install(), /校验失败/)
  assert.equal((await manager.status()).installed, false)
  const controller = new AbortController()
  controller.abort()
  const cancelled = new RuntimeManager({ home: manager.home, accountId: 'other-account', manifest, signal: controller.signal })
  assert.notEqual(cancelled.installDirectory, manager.installDirectory)
  await assert.rejects(cancelled.install(), { name: 'AbortError' })
})

test('ZIP and installed paths reject traversal, missing content and directory links', async t => {
  const { root, release } = await fixture(t)
  for (const path of ['../outside', 'C:/outside', 'foo/../../outside', 'foo\\bar', '/outside', 'NUL.txt', 'a/CON', 'a:ads']) assert.throws(() => safeEntry(path))
  const destination = join(root, 'extract')
  const invalid = { ...release.files[0], sha256: '0'.repeat(64) }
  await assert.rejects(extractVerified(join(root, 'runtime.zip'), destination, [invalid, ...release.files.slice(1)]), /校验失败/)
  await assert.rejects(validateInstalled(destination, release))
  const target = join(root, 'target'), link = join(root, 'linked')
  await mkdir(target)
  try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') return; throw error }
  await assert.rejects(safeDirectory(link), /链接/)
  await assert.rejects(validateInstalled(link, release), /链接/)
})

test('download failure leaves previous installation bytes intact and unknown platform has no executable', async t => {
  const { manager, manifest } = await fixture(t)
  await manager.install()
  const executable = (await manager.descriptor()).command
  await writeFile(executable, 'old-installed-version')
  manager.fetch = async () => { throw new Error('network unavailable') }
  await assert.rejects(manager.install(), /network unavailable/)
  assert.equal(await readFile(executable, 'utf8'), 'old-installed-version')
  const unsupported = new RuntimeManager({ home: manager.home, accountId: 'unsupported', manifest: { ...manifest, platforms: {} } })
  assert.equal((await unsupported.status()).supported, false)
  await assert.rejects(unsupported.install(), /平台/)
})

test('failed atomic replacement restores old bytes; a failed restore preserves the backup', async t => {
  const { manager } = await fixture(t)
  await manager.install()
  const executable = (await manager.descriptor()).command
  await writeFile(executable, 'old-version-to-restore')
  manager.rename = async (from, to) => {
    if (from.includes('.staging-') && !from.endsWith('.backup') && to === manager.installDirectory) throw new Error('replacement failed')
    return rename(from, to)
  }
  await assert.rejects(manager.install(), /replacement failed/)
  assert.equal(await readFile(executable, 'utf8'), 'old-version-to-restore')
  manager.rename = async (from, to) => {
    if (to === manager.installDirectory) throw new Error('filesystem unavailable')
    return rename(from, to)
  }
  await assert.rejects(manager.install(), /旧版保留/)
  const parent = join(manager.installDirectory, '..')
  const backup = (await readdir(parent)).find(name => name.endsWith('.backup'))
  assert.ok(backup)
  assert.equal(await readFile(join(parent, backup, 'EZ-Tree.exe'), 'utf8'), 'old-version-to-restore')
})

test('concurrent directory creation tolerates another successful creator', async t => {
  const { root } = await fixture(t)
  const directory = join(root, 'parallel/deep/final')
  const results = await Promise.all(Array.from({ length: 10 }, () => safeDirectory(directory)))
  assert.equal(new Set(results).size, 1)
})

async function withLegacy(t) {
  const legacy = await fixture(t, '0.1.0')
  const current = await fixture(t)
  current.manager.legacyManifests = { '0.1.0': legacy.manifest }
  const legacyDirectory = current.manager.runtimeDirectory('0.1.0')
  await extractVerified(legacy.archive, legacyDirectory, legacy.release.files)
  return { ...current, legacy, legacyDirectory }
}

test('verified historical installation stays usable through upgrade, including old MCP paths and project bytes', async t => {
  const { manager, legacyDirectory } = await withLegacy(t)
  const old = await manager.descriptor()
  assert.equal(old.version, '0.1.0')
  assert.equal(old.command, join(legacyDirectory, 'EZ-Tree.exe'))
  const before = await manager.status()
  assert.equal(before.installed, true)
  assert.equal(before.version, '0.1.0')
  assert.equal(before.targetVersion, VERSION)
  assert.equal(before.updateAvailable, true)
  const project = join(manager.dataDirectory, 'projects', 'original.json')
  await safeDirectory(dirname(project))
  const projectBytes = Buffer.from('{"seed":97531,"name":"原项目"}\n')
  await writeFile(project, projectBytes)
  const previousExecutable = await readFile(old.command)
  let downloads = 0
  const fetch = manager.fetch
  manager.fetch = async (...args) => { downloads++; return fetch(...args) }
  const upgraded = await manager.install()
  assert.equal(downloads, 1, 'legacy installed state must not short-circuit target installation')
  assert.equal(upgraded.version, VERSION)
  assert.equal(upgraded.updateAvailable, false)
  const current = await manager.descriptor()
  assert.equal(current.version, VERSION)
  assert.notEqual(current.command, old.command)
  assert.deepEqual(await readFile(old.command), previousExecutable, 'saved MCP command remains valid')
  assert.deepEqual(await readFile(project), projectBytes)
  const unrelated = join(manager.dataDirectory, 'runtime', '9.9.9', 'not-managed.txt')
  await safeDirectory(dirname(unrelated))
  await writeFile(unrelated, 'keep unknown installation')
  await manager.uninstall()
  await assert.rejects(readFile(old.command), { code: 'ENOENT' })
  await assert.rejects(readFile(current.command), { code: 'ENOENT' })
  assert.deepEqual(await readFile(project), projectBytes)
  assert.equal(await readFile(unrelated, 'utf8'), 'keep unknown installation')
})

test('failed upgrade and corrupt target fall back only to hash-verified historical runtime', async t => {
  const { manager } = await withLegacy(t)
  const old = await manager.descriptor()
  manager.fetch = async () => { throw new Error('upgrade network unavailable') }
  await assert.rejects(manager.install(), /upgrade network unavailable/)
  assert.equal((await manager.descriptor()).command, old.command)
  assert.equal((await manager.status()).updateAvailable, true)
  await safeDirectory(manager.installDirectory)
  await writeFile(join(manager.installDirectory, 'EZ-Tree.exe'), 'incomplete-target')
  assert.equal((await manager.descriptor()).command, old.command)
  await writeFile(old.command, 'untrusted historical executable')
  assert.equal((await manager.status()).installed, false)
  await assert.rejects(manager.descriptor(), /损坏|不完整|缺少|ENOENT/)
})

test('legacy GUI validates its own version marker and blocks upgrade or uninstall until closed', async t => {
  const { manager } = await withLegacy(t)
  manager.spawn = (command, args) => {
    const child = new EventEmitter()
    child.pid = 912345
    child.exitCode = null
    child.signalCode = null
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); return true }
    const marker = args[args.indexOf('--ready-file') + 1]
    void writeFile(marker, JSON.stringify({ pid: child.pid, version: '0.1.0', executable: command }))
      .catch(error => child.emit('error', error))
    return child
  }
  t.after(() => manager.stop())
  const running = await manager.launch()
  assert.equal(running.version, '0.1.0')
  assert.equal(running.running, true)
  await assert.rejects(manager.install(), /关闭/)
  await assert.rejects(manager.uninstall(), /关闭/)
  await manager.stop()
  assert.equal((await manager.install()).version, VERSION)
})
