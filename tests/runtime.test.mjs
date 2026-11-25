import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, rename, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { RuntimeManager } from '../plugin/runtime.mjs'
import { safeDirectory, safeEntry, validateInstalled, extractVerified } from '../plugin/archive.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const temporary = await realpath(tmpdir())
  const root = await mkdtemp(join(temporary, 'ez-tree-test-'))
  t.after(async () => { assert.ok(resolve(root).startsWith(temporary + '\\') || resolve(root).startsWith(temporary + '/')); await rm(root, { recursive: true, force: true }) })
  const content = { 'EZ-Tree.exe': 'test-runtime', 'resources/app/package.json': JSON.stringify({ name: 'dsh-ez-tree-desktop', version: '0.1.0' }), 'resources/app/lib/mcp/cli.mjs': 'test-mcp-launcher' }
  const input = join(root, 'input')
  await safeDirectory(input)
  for (const [path, data] of Object.entries(content)) { await safeDirectory(join(input, path, '..')); await writeFile(join(input, path), data) }
  const archive = join(root, 'runtime.zip')
  const source = 'import zipfile,os,sys\nwith zipfile.ZipFile(sys.argv[2],"w",compression=zipfile.ZIP_DEFLATED) as z:\n for base,dirs,files in os.walk(sys.argv[1]):\n  for f in files:\n   p=os.path.join(base,f);z.write(p,os.path.relpath(p,sys.argv[1]).replace(os.sep,"/"))'
  execFileSync(process.platform === 'win32' ? 'py' : 'python3', [...(process.platform === 'win32' ? ['-3'] : []), '-c', source, input, archive], { windowsHide: true })
  const bytes = await readFile(archive)
  const release = { url: `https://github.com/asun-labs/dsh-ez-tree/releases/download/v0.1.0/dsh-ez-tree-0.1.0-${process.platform}-${process.arch}.zip`, sha256: sha(bytes), bytes: bytes.length, executable: 'EZ-Tree.exe',
    mcp: { entry: 'resources/app/lib/mcp/cli.mjs', env: { ELECTRON_RUN_AS_NODE: '1' } },
    files: Object.entries(content).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: sha(value) })) }
  const manifest = { appId: 'com.asun-labs.ez-tree', version: '0.1.0', platforms: { [`${process.platform}-${process.arch}`]: release } }
  const manager = new RuntimeManager({ home: join(root, 'home'), accountId: 'test-account', manifest, fetchImpl: async () => new Response(bytes) })
  return { root, manager, bytes, release, manifest }
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
