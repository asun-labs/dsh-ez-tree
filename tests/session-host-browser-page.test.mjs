import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserPageService } from '../plugin/browser-page-service.mjs'

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ez-tree-browser-page-'))
  const directory = join(root, 'editor')
  await mkdir(join(directory, 'assets'), { recursive: true })
  await writeFile(join(directory, 'index.html'), '<!doctype html><canvas></canvas>')
  await writeFile(join(directory, 'assets/app.js'), 'window.loaded=true')
  let current = { accountId: 'account-a', epoch: 1, mode: 'local' }, workspace = join(root, 'workspace')
  await mkdir(workspace)
  const calls = [], failures = []
  let snapshot = { cursor: 0, project: null, command: null }
  const store = {
    read: async () => snapshot,
    fail: async (_scope, sessionId, operationId, message) => { failures.push({ sessionId, operationId, message }); return { accepted: true } },
  }
  const assertScope = scope => {
    if (scope.accountId !== current.accountId || scope.epoch !== current.epoch) throw Object.assign(new Error('Account changed'), { code: 'identityChanged' })
  }
  const handlers = Object.fromEntries(['Read', 'Watch', 'Edit', 'Export', 'Ack', 'Fail'].map(name => ['editor' + name, async (payload, signal) => {
    calls.push({ name, payload })
    if (overrides.watch && name === 'Watch') return overrides.watch(payload, signal)
    return { ...snapshot, accountScope: 'opaque' }
  }]))
  const service = new BrowserPageService({ ctx: { logger: { warn() {} } }, store, scope: () => current, assertScope, handlers,
    editorDirectory: directory, async checkView(scope, sessionId, path, signal) {
      signal?.throwIfAborted()
      assertScope(scope)
      if (sessionId !== 'session-one') throw Object.assign(new Error('Unknown session'), { code: 'sessionUnavailable' })
      if (path !== workspace) throw Object.assign(new Error('Workspace changed'), { code: 'workspaceChanged' })
    }, ...overrides })
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }) })
  async function launch() { return service.launch({ ...current }, 'session-one', { workspace }) }
  return { service, launch, calls, failures, workspace, scope: () => ({ ...current }),
    setScope(value) { current = value }, setWorkspace(value) { workspace = value }, setSnapshot(value) { snapshot = value } }
}
function endpoint(launch, method) { return new URL('./api/' + method, new URL(launch.url).href.split('#')[0]) }
async function api(launch, method, payload = {}, cookie, options = {}) {
  const url = endpoint(launch, method)
  return fetch(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload), ...options })
}
async function redeem(launch) {
  const token = new URLSearchParams(new URL(launch.url).hash.slice(1)).get('bootstrap')
  const response = await api(launch, 'redeem', { token })
  assert.equal(response.status, 200)
  return { cookie: response.headers.get('set-cookie').split(';')[0], header: response.headers.get('set-cookie'), token }
}

test('loopback service binds lazily and exchanges a one-time fragment for a path-scoped HttpOnly cookie', async t => {
  const f = await fixture(t)
  assert.equal(f.service.server, undefined)
  const launched = await f.launch(), url = new URL(launched.url)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.search, '')
  assert.match(url.hash, /^#bootstrap=[A-Za-z0-9_-]{43}$/)
  const page = await fetch(url.href.split('#')[0])
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  const credential = await redeem(launched)
  assert.match(credential.header, /HttpOnly/)
  assert.match(credential.header, /SameSite=Strict/)
  assert.ok(credential.header.includes('Path=/view/' + launched.leaseId + '/'))
  assert.match(credential.header, /Max-Age=28800/)
  const read = await api(launched, 'read', {}, credential.cookie)
  assert.equal(read.status, 200)
  assert.equal(f.calls.at(-1).payload.sessionId, 'session-one')
  assert.equal((await read.json()).value.accountScope, 'opaque')
  assert.equal((await api(launched, 'redeem', { token: credential.token })).status, 401)
})

test('concurrent ticket redemption succeeds once and replacing a view revokes the previous page', async t => {
  const f = await fixture(t)
  const first = await f.launch(), token = new URLSearchParams(new URL(first.url).hash.slice(1)).get('bootstrap')
  const responses = await Promise.all([api(first, 'redeem', { token }), api(first, 'redeem', { token })])
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 401])
  const credential = responses.find(value => value.status === 200).headers.get('set-cookie').split(';')[0]
  const second = await f.launch()
  assert.notEqual(second.leaseId, first.leaseId)
  assert.equal((await api(first, 'read', {}, credential)).status, 401)
  assert.equal((await fetch(first.url.split('#')[0])).status, 401)
})

test('exact Host and Origin checks reject rebinding, cross-origin calls and unsigned APIs', async t => {
  const f = await fixture(t), launched = await f.launch(), credential = await redeem(launched)
  assert.equal((await api(launched, 'read')).status, 401)
  const url = endpoint(launched, 'read')
  for (const origin of [undefined, 'null', 'http://attacker.invalid']) {
    const response = await api(launched, 'read', {}, credential.cookie, { headers: { ...(origin ? { origin } : {}), cookie: credential.cookie, 'content-type': 'application/json' } })
    assert.equal(response.status, 403)
    assert.equal(response.headers.has('access-control-allow-origin'), false)
  }
  const status = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { host: 'attacker.invalid', origin: url.origin, 'content-type': 'application/json', cookie: credential.cookie } },
      res => { res.resume(); res.once('end', () => resolve(res.statusCode)) })
    req.once('error', reject); req.end('{}')
  })
  assert.equal(status, 403)
  assert.equal(f.calls.length, 0)
})

test('page endpoints cannot select another session/account/workspace or invoke general owner APIs', async t => {
  const f = await fixture(t), launched = await f.launch(), credential = await redeem(launched)
  for (const payload of [{ sessionId: 'victim' }, { accountId: 'other' }, { workspace: '/outside' }])
    assert.equal((await api(launched, 'read', payload, credential.cookie)).status, 400)
  assert.equal((await api(launched, 'tools/execute', {}, credential.cookie)).status, 404)
  const response = await api(launched, 'edit', { expectedRevision: 0, options: { seed: 99 } }, credential.cookie)
  assert.equal(response.status, 200)
  assert.deepEqual(f.calls.at(-1).payload, { expectedRevision: 0, options: { seed: 99 }, sessionId: 'session-one' })
  assert.equal((await api(launched, 'read', { note: 'x'.repeat(20000) }, credential.cookie)).status, 413)
  const wrongPath = new URL('/api/read', new URL(launched.url).origin)
  assert.equal((await fetch(wrongPath)).status, 404)
})

test('tickets, epoch, workspace and idle/absolute expirations are independently enforced', async t => {
  let clock = 100000
  const f = await fixture(t, { now: () => clock, ticketTtlMs: 50, idleTtlMs: 1000, absoluteTtlMs: 10000 })
  const expiredTicket = await f.launch()
  clock += 51
  assert.equal((await api(expiredTicket, 'redeem', { token: new URLSearchParams(new URL(expiredTicket.url).hash.slice(1)).get('bootstrap') })).status, 401)
  const active = await f.launch(), credential = await redeem(active)
  clock += 900; assert.equal((await api(active, 'read', {}, credential.cookie)).status, 200)
  clock += 900; assert.equal((await api(active, 'read', {}, credential.cookie)).status, 200)
  clock += 1001; assert.equal((await api(active, 'read', {}, credential.cookie)).status, 401)
  const epoch = await f.launch(), previous = await redeem(epoch)
  f.setScope({ accountId: 'account-a', epoch: 2, mode: 'local' })
  assert.equal((await api(epoch, 'read', {}, previous.cookie)).status, 409)
  assert.equal(f.service.state(f.scope(), 'session-one'), null)
  const moved = await f.launch(), movedCookie = await redeem(moved)
  f.setWorkspace('/changed')
  assert.equal((await api(moved, 'read', {}, movedCookie.cookie)).status, 409)
  const absolute = await f.launch(), activeCookie = await redeem(absolute)
  for (let count = 0; count < 11; count++) {
    clock += 900
    assert.equal((await api(absolute, 'read', {}, activeCookie.cookie)).status, 200)
  }
  clock += 101
  assert.equal((await api(absolute, 'read', {}, activeCookie.cookie)).status, 401)
})

test('soft release permits reload and fails only the pending operation actually observed by that view', async t => {
  let clock = 100000
  const f = await fixture(t, { now: () => clock }), launched = await f.launch(), credential = await redeem(launched)
  f.setSnapshot({ cursor: 1, project: null, command: { operationId: 'observed-operation', kind: 'apply', project: {} } })
  await api(launched, 'read', {}, credential.cookie)
  assert.equal((await api(launched, 'release', {}, credential.cookie)).status, 200)
  assert.equal(f.failures.length, 1)
  assert.equal(f.failures[0].operationId, 'observed-operation')
  assert.equal(f.service.state(f.scope(), 'session-one').connected, true)
  clock += 5001
  assert.equal(f.service.state(f.scope(), 'session-one').connected, false)
  assert.equal((await api(launched, 'read', {}, credential.cookie)).status, 200)
  assert.equal(f.service.state(f.scope(), 'session-one').connected, true)
  f.setSnapshot({ cursor: 2, project: null, command: { operationId: 'new-unseen-operation', kind: 'apply', project: {} } })
  await api(launched, 'release', {}, credential.cookie)
  assert.equal(f.failures.length, 1)
})

test('disposing the service aborts long polls and releases its owned loopback listener', async t => {
  let started = false
  const f = await fixture(t, { watch: (_payload, signal) => { started = true; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } })
  const launched = await f.launch(), credential = await redeem(launched)
  const watching = api(launched, 'watch', { afterCursor: 0 }, credential.cookie).catch(error => error)
  for (let count = 0; count < 100 && !started; count++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(started, true)
  await f.service.dispose()
  await watching
  assert.equal(f.service.leases.size, 0)
  await assert.rejects(fetch(launched.url.split('#')[0]))
})
