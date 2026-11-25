import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerRpcRoute } from '../plugin/index.mjs'

const owner = { principal: { kind: 'owner' } }
const envelope = { type: 'client-request', rpcId: '1bab14dc-7704-420c-999f-099277d78577', method: 'status', payload: {} }

function transport({ legacyAdmission = () => ({ peer: owner }) } = {}) {
  let route, admits = 0
  const calls = []
  const ctx = { effect: callback => callback(), webServer: { register: value => { route = value; return () => {} } },
    connection: { admit: request => { admits++; return legacyAdmission(request) } } }
  registerRpcRoute(ctx, async (action, payload, signal, peer) => {
    calls.push({ action, payload, signal, peer })
    return peer?.principal?.kind === 'owner' ? { ok: true, value: { ready: true } }
      : { ok: false, error: { code: 'forbidden', message: 'owner only', details: {} } }
  })
  return { route, calls, admits: () => admits }
}

async function send(route, { body = JSON.stringify(envelope), peer, url = '/dsh-ez-tree/status', method = 'POST', contentType = 'application/json', chunks } = {}) {
  const request = Object.assign(Readable.from(chunks ?? [Buffer.from(body)]), { url, method, headers: { 'content-type': contentType } })
  const response = { destroyed: false, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
  await route.handler(request, response, peer)
  return response
}

test('actual 0.2.3 desktop envelope uses the carrier-admitted Peer without accessing its restricted auth service', async () => {
  const f = transport({ legacyAdmission() { throw new Error('cannot get property "connection.authentication" without inject') } })
  assert.equal(f.route.auth, 'required')
  const response = await send(f.route, { peer: owner })
  assert.equal(response.status, 200)
  assert.equal(f.admits(), 0)
  assert.equal(f.calls[0].peer, owner)
  assert.deepEqual(JSON.parse(response.body), { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { ready: true } } })
})

test('0.2.2 carrier without a Peer still executes Connection admission and preserves denial', async () => {
  const accepted = transport()
  assert.equal((await send(accepted.route)).status, 200)
  assert.equal(accepted.admits(), 1)
  const refused = transport({ legacyAdmission: () => ({ rejection: 403 }) })
  assert.equal((await send(refused.route)).status, 403)
  assert.equal(refused.calls.length, 0)
})

test('non-owner carrier Peer is forwarded to the owner boundary rather than replaced with owner identity', async () => {
  const f = transport()
  const peer = { principal: { kind: 'remote' } }
  const response = await send(f.route, { peer })
  assert.equal(f.admits(), 0)
  assert.equal(f.calls[0].peer, peer)
  assert.equal(JSON.parse(response.body).result.error.code, 'forbidden')
})

test('invalid JSON, mismatched methods and unknown framing fields remain rejected', async () => {
  const f = transport()
  for (const body of ['{', JSON.stringify({ ...envelope, method: 'install' }), JSON.stringify({ ...envelope, rpcId: 4 }), JSON.stringify({ ...envelope, extra: 'unrecognized' })]) {
    assert.equal((await send(f.route, { body, peer: owner })).status, 400)
  }
  assert.equal((await send(f.route, { peer: owner, contentType: 'text/plain' })).status, 415)
  assert.equal((await send(f.route, { peer: owner, url: '/dsh-ez-tree/unknown' })).status, 404)
  assert.equal(f.calls.length, 0)
})

test('split chunks preserve JSON framing and request cap counts UTF-8 bytes', async () => {
  const f = transport()
  const body = JSON.stringify(envelope)
  const response = await send(f.route, { peer: owner, chunks: [Buffer.from(body.slice(0, 25)), Buffer.from(body.slice(25))] })
  assert.equal(response.status, 200)
  const tooLarge = JSON.stringify({ ...envelope, payload: { note: '树'.repeat(6000) } })
  assert.ok(tooLarge.length < 16384)
  assert.equal((await send(f.route, { peer: owner, chunks: [tooLarge] })).status, 413)
  assert.equal(f.calls.length, 1)
})
