import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { ProjectStore } from '../plugin/projects.mjs'
import { createSessionRoutes, MAX_EDITOR_UPLOAD_BYTES } from '../plugin/session-routes.mjs'

const owner = { principal: { kind: 'owner' } }
async function fixture(t, { uploadLimit, legacy = false, admitted = owner } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ez-tree-routes-'))
  const editorDirectory = join(root, 'editor'), workspace = join(root, 'workspace')
  await mkdir(join(editorDirectory, 'assets'), { recursive: true }); await mkdir(workspace)
  await writeFile(join(editorDirectory, 'index.html'), '<!doctype html><canvas></canvas>')
  await writeFile(join(editorDirectory, 'assets/app.js'), 'window.editorLoaded=true')
  await writeFile(join(editorDirectory, 'assets/render.wasm'), Buffer.from([0, 97, 115, 109]))
  let account = { accountId: 'route-user', epoch: 1 }
  const store = new ProjectStore({ home: join(root, 'home'), renderTimeoutMs: 700 })
  let admits = 0, sessionChecks = 0
  const ctx = { connection: { admit() { admits++; return admitted?.principal ? { peer: admitted } : { rejection: 401 } } }, logger: { warn() {} } }
  const routes = createSessionRoutes(ctx, { store, editorDirectory, uploadLimit, scope: () => ({ ...account }),
    assertScope(scope) { if (scope.accountId !== account.accountId || scope.epoch !== account.epoch) throw Object.assign(new Error('Account changed'), { code: 'identityChanged' }) },
    assertSession(_scope, id) { sessionChecks++; if (id !== 'session-one') throw Object.assign(new Error('Unknown session'), { status: 403, code: 'sessionUnavailable' }) } })
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const route = pathname === '/dsh-ez-tree/export' ? routes.exportRoute : routes.staticRoute
    void route.handler(request, response, legacy ? undefined : admitted).catch(error => { response.writeHead(500); response.end(error.message) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { store.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  return { root, workspace, editorDirectory, store, scope: () => ({ ...account }), admits: () => admits, sessionChecks: () => sessionChecks,
    setAccount(value) { account = value },
    get: (path, options) => fetch(origin + path, options),
    upload: (operationId, bytes, query = '') => fetch(`${origin}/dsh-ez-tree/export?sessionId=session-one&operationId=${operationId}${query}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes }) }
}
async function command(f) {
  for (let count = 0; count < 100; count++) {
    const current = await f.store.read(f.scope(), 'session-one')
    if (current.command) return current.command
    await pause(2)
  }
  throw new Error('Missing command')
}
async function open(f) {
  const result = f.store.open(f.scope(), 'session-one', { workspace: f.workspace })
  const current = await command(f)
  await f.store.ack(f.scope(), 'session-one', { operationId: current.operationId, revision: current.project.revision,
    optionsDigest: current.project.optionsDigest, metrics: { vertexCount: 1000, triangleCount: 800 } })
  return result
}

test('authenticated editor routes stream real files through Node HTTP with HEAD and correct wasm MIME', async t => {
  const f = await fixture(t)
  const page = await f.get('/dsh-ez-tree/editor/index.html')
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(await page.text(), /canvas/)
  const wasm = await f.get('/dsh-ez-tree/editor/assets/render.wasm')
  assert.equal(wasm.headers.get('content-type'), 'application/wasm')
  assert.equal((await wasm.arrayBuffer()).byteLength, 4)
  const head = await f.get('/dsh-ez-tree/editor/index.html', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '32'); assert.equal(await head.text(), '')
  assert.equal(f.admits(), 0)
})

test('legacy admission and owner restrictions protect editor resources', async t => {
  const accepted = await fixture(t, { legacy: true })
  assert.equal((await accepted.get('/dsh-ez-tree/editor')).status, 200)
  assert.equal(accepted.admits(), 1)
  const denied = await fixture(t, { admitted: { principal: { kind: 'remote' } } })
  assert.equal((await denied.get('/dsh-ez-tree/editor')).status, 403)
  const unsigned = await fixture(t, { legacy: true, admitted: null })
  assert.equal((await unsigned.get('/dsh-ez-tree/editor')).status, 401)
})

test('static paths reject encoded traversal, backslashes, hidden files and linked directories', async t => {
  const f = await fixture(t)
  assert.equal((await f.get('/dsh-ez-tree/editor/..%2fprivate.txt')).status, 403)
  assert.equal((await f.get('/dsh-ez-tree/editor/assets%5cprivate.txt')).status, 403)
  assert.equal((await f.get('/dsh-ez-tree/editor/.env')).status, 403)
  assert.equal((await f.get('/dsh-ez-tree/not-editor')).status, 404)
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'private')
  try { await symlink(outside, join(f.editorDirectory, 'assets/link'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') return; throw error }
  const response = await f.get('/dsh-ez-tree/editor/assets/link/secret.txt')
  assert.equal(response.status, 403); assert.equal((await response.text()).includes('private'), false)
})

test('binary export validates a pending operation and writes the actual current parameter JSON', async t => {
  const f = await fixture(t)
  await open(f)
  const pending = f.store.export(f.scope(), 'session-one', { format: 'json', name: 'shared-tree' })
  const current = await command(f)
  const response = await f.upload(current.operationId, Buffer.from(JSON.stringify(current.project.options)))
  assert.equal(response.status, 200)
  const result = await response.json(), artifact = await pending
  assert.equal(result.value.path, artifact.path)
  assert.deepEqual(JSON.parse(await readFile(artifact.path)), current.project.options)
  assert.ok(artifact.path.startsWith(join(f.workspace, 'models/ez-tree')))
})

test('a stale export operation and user-supplied output paths cannot replace the active pending command', async t => {
  const f = await fixture(t)
  await open(f)
  const pending = f.store.export(f.scope(), 'session-one', { format: 'json' })
  const failed = assert.rejects(pending, { code: 'rendererFailed' })
  const current = await command(f)
  assert.equal((await f.upload('wrong-operation', Buffer.from('{}'))).status, 409)
  assert.equal((await f.upload(current.operationId, Buffer.from('{}'), '&workspace=C:/outside')).status, 400)
  assert.equal((await f.store.read(f.scope(), 'session-one')).command.operationId, current.operationId)
  await f.store.fail(f.scope(), 'session-one', current.operationId, 'test cleanup')
  await failed
})

test('oversized binary input cancels the pending export without allocating an unbounded request', async t => {
  assert.equal(MAX_EDITOR_UPLOAD_BYTES, 128 * 1024 * 1024)
  const f = await fixture(t, { uploadLimit: 32 })
  await open(f)
  const pending = f.store.export(f.scope(), 'session-one', { format: 'json' })
  const failed = assert.rejects(pending, { code: 'rendererFailed' })
  const current = await command(f)
  const response = await f.upload(current.operationId, Buffer.alloc(64))
  assert.equal(response.status, 413)
  await failed
  assert.equal((await f.store.read(f.scope(), 'session-one')).command, null)
})

test('invalid image signatures fail the real exporter and release the tool wait', async t => {
  const f = await fixture(t)
  await open(f)
  const pending = f.store.export(f.scope(), 'session-one', { format: 'png' })
  const failed = assert.rejects(pending, { code: 'rendererFailed' })
  const current = await command(f)
  const response = await f.upload(current.operationId, Buffer.from('not an image'))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'invalidExport')
  await failed
})

test('account changes during an in-flight binary upload cannot publish the old account export', async t => {
  const f = await fixture(t)
  await open(f)
  const pending = f.store.export(f.scope(), 'session-one', { format: 'json' })
  const failed = assert.rejects(pending, { code: 'rendererFailed' })
  const current = await command(f), bytes = Buffer.from(JSON.stringify(current.project.options))
  let writer
  const body = new ReadableStream({ start(controller) { writer = controller; controller.enqueue(bytes.subarray(0, 3)) } })
  const response = f.get(`/dsh-ez-tree/export?sessionId=session-one&operationId=${current.operationId}`,
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half' })
  for (let count = 0; count < 100 && !f.sessionChecks(); count++) await pause(2)
  await pause(5)
  f.setAccount({ accountId: 'other-account', epoch: 2 })
  writer.enqueue(bytes.subarray(3)); writer.close()
  assert.equal((await response).status, 409)
  await failed
  await assert.rejects(readFile(join(f.workspace, 'models/ez-tree')), { code: 'ENOENT' })
})
