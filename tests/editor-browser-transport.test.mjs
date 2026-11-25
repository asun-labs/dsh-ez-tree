import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserTransport } from '../app/browser-transport.mjs'
import { ProjectStore } from '../plugin/projects.mjs'

async function fixture(t, { failFirst = false, delayPersistMs = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ez-tree-page-transport-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const scope = { accountId: 'page-owner', epoch: 1 }
  const store = new ProjectStore({ home: join(root, 'home'), renderTimeoutMs: 1500, watchTimeoutMs: 15 })
  if (delayPersistMs) {
    const persist = store.persist.bind(store)
    store.persist = async (...args) => { await new Promise(resolve => setTimeout(resolve, delayPersistMs)); return persist(...args) }
  }
  const opening = store.open(scope, 'session-page', { workspace })
  opening.catch(() => {})
  const calls = [], replaces = [], listeners = new Map(), errors = [], flags = { denied: false }
  let rendered, disposed = false
  const location = { href: 'http://127.0.0.1:12345/view/test-view/index.html#bootstrap=one-time-secret',
    pathname: '/view/test-view/index.html', search: '', hash: '#bootstrap=one-time-secret' }
  const target = { location, history: { replaceState(_state, _unused, value) { replaces.push(value) } },
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) }
  const fetchImpl = async (url, options) => {
    const action = new URL(url).pathname.split('/').at(-1)
    const value = typeof options.body === 'string' ? JSON.parse(options.body) : null
    calls.push({ url, action, value, options })
    if (flags.denied) return Response.json({ ok: false, error: { code: 'viewUnauthorized', message: 'view access expired' } }, { status: 401 })
    try {
      let result
      if (action === 'redeem') { assert.deepEqual(value, { token: 'one-time-secret' }); result = { leaseId: 'test-view' } }
      else if (action === 'read') result = await store.read(scope, 'session-page')
      else if (action === 'watch') result = await store.watch(scope, 'session-page', value.afterCursor, options.signal)
      else if (action === 'edit') { result = await store.edit(scope, 'session-page', value); if (flags.editGate) await flags.editGate }
      else if (action === 'export') result = await store.export(scope, 'session-page', value)
      else if (action === 'ack') result = await store.ack(scope, 'session-page', value)
      else if (action === 'fail') result = await store.fail(scope, 'session-page', value.operationId, value.message)
      else if (action === 'upload') result = await store.upload(scope, 'session-page', new URL(url).searchParams.get('operationId'), options.body)
      else if (action === 'release') result = { released: true }
      else throw new Error(`Unexpected page action ${action}`)
      return Response.json({ ok: true, value: result })
    } catch (error) { return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: 400 }) }
  }
  let transport
  const handlers = {
    async applyProject(project) {
      rendered = structuredClone(project)
      if (failFirst) { failFirst = false; throw new Error('simulated first render failed') }
      return { revision: project.revision, optionsDigest: project.optionsDigest, vertexCount: 1000, triangleCount: 800 }
    },
    async exportFile({ format, revision }) {
      assert.equal(transport.pendingMutation, false, 'export cannot read a local uncommitted parameter draft')
      assert.equal(format, 'json'); assert.equal(revision, rendered.revision)
      return { buffer: new TextEncoder().encode(JSON.stringify(rendered.options)).buffer, revision, optionsDigest: rendered.optionsDigest }
    },
    dispose() { disposed = true; rendered = null },
  }
  transport = createBrowserTransport({ target, fetchImpl, ready: async () => true, handlers,
    report: message => errors.push(message), retryDelay: 1 })
  t.after(async () => { transport.dispose(); store.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
  return { transport, opening, store, scope, calls, replaces, target, fetchImpl, handlers, listeners, errors, flags,
    get rendered() { return rendered }, get disposed() { return disposed } }
}

test('browser bootstrap clears its fragment before redeem and uses only narrow same-origin cookie APIs', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.replaces, ['/view/test-view/index.html'])
  await f.transport.ready
  await f.opening
  assert.equal(f.calls[0].action, 'redeem')
  assert.ok(f.calls.every(call => call.options.credentials === 'same-origin'))
  assert.ok(f.calls.every(call => !new URL(call.url).hash && !new URL(call.url).searchParams.has('sessionId')))
  assert.equal(f.rendered.options.seed, (await f.transport.readProject()).options.seed)
  await assert.rejects(f.transport.requestIntent({ expectedRevision: 0, accountId: 'other' }), /不支持/)
  await assert.rejects(f.transport.exportFile({ format: 'json', workspace: '/outside' }), /只接受/)
})

test('watch and real Host ACK keep running while a manual edit or binary export awaits its response', async t => {
  const f = await fixture(t)
  await f.transport.ready; await f.opening
  const updated = await f.transport.requestIntent({ expectedRevision: 0, options: { seed: 97531 } })
  assert.equal(updated.revision, 1)
  assert.equal(updated.options.seed, 97531)
  assert.equal(f.rendered.options.seed, 97531)
  const artifact = await f.transport.exportFile({ format: 'json', name: 'page-tree' })
  assert.equal(artifact.revision, 1)
  assert.equal(artifact.seed, 97531)
  const upload = f.calls.find(call => call.action === 'upload')
  assert.equal(upload.options.headers['content-type'], 'application/octet-stream')
  assert.ok(upload.options.body instanceof ArrayBuffer)
  assert.equal(JSON.parse(new TextDecoder().decode(upload.options.body)).seed, 97531)
  await assert.rejects(f.transport.requestIntent({ expectedRevision: 0, options: { seed: 1 } }), /更新/)
  assert.equal((await f.transport.readProject()).options.seed, 97531)
})

test('failed first render never becomes ready or leaves an uncommitted candidate visible', async t => {
  const f = await fixture(t, { failFirst: true })
  await assert.rejects(f.transport.ready, /first render failed/)
  await assert.rejects(f.opening, /first render failed/)
  assert.equal((await f.store.read(f.scope, 'session-page')).project, null)
  assert.equal(f.disposed, true)
  assert.equal(f.rendered, null)
  assert.ok(f.calls.some(call => call.action === 'release' && call.options.keepalive === true))
})

test('post-ACK heartbeat during slow first persistence waits for commit without falsely rejecting readiness', async t => {
  const f = await fixture(t, { delayPersistMs: 90 })
  let ready = false
  f.transport.ready.then(() => { ready = true })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(ready, false, 'render ACK is not yet a committed project')
  assert.equal(f.disposed, false, 'a heartbeat without project or error is not a failed render')
  await f.transport.ready
  await f.opening
  assert.equal((await f.transport.readProject()).revision, 0)
  assert.equal(f.disposed, false)
})

test('a trusted queued export completes when edit is committed but its HTTP response is still delayed', async t => {
  const f = await fixture(t)
  await f.transport.ready; await f.opening
  let releaseResponse
  f.flags.editGate = new Promise(resolve => { releaseResponse = resolve })
  const editing = f.transport.requestIntent({ expectedRevision: 0, options: { seed: 24680 } })
  const deadline = Date.now() + 1000
  while ((await f.store.read(f.scope, 'session-page')).project.revision !== 1) {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(f.transport.pendingMutation, true)
  const artifact = await f.store.export(f.scope, 'session-page', { format: 'json', name: 'queued-after-edit' })
  assert.equal(artifact.revision, 1)
  assert.equal(artifact.seed, 24680)
  releaseResponse()
  assert.equal((await editing).options.seed, 24680)
})

test('expired view stops rendering and normal pagehide releases softly without transmitting project credentials', async t => {
  const f = await fixture(t)
  await f.transport.ready; await f.opening
  f.listeners.get('pagehide')()
  const released = f.calls.find(call => call.action === 'release')
  assert.deepEqual(released.value, {})
  assert.equal(released.options.keepalive, true)
  assert.equal(released.options.credentials, 'same-origin')
  f.flags.denied = true
  await assert.rejects(f.transport.readProject(), /expired/)
  assert.equal(f.disposed, true)
  assert.equal(f.rendered, null)
})
