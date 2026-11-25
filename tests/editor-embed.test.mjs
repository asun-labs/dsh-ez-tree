import test from 'node:test'
import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createEmbeddedBridge } from '../app/embed-bridge.mjs'
import { validateProject, optionChanges, actualOptionsDigest, verifyProjectOptions } from '../app/embed-project.mjs'
import { optionsDigest as hostOptionsDigest } from '../plugin/projects.mjs'

function fixture(t, overrides = {}, ready = async () => true) {
  const listeners = new Map()
  const target = { parent: {}, location: { origin: 'dsh-app://app' },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type) }
  const channel = new MessageChannel()
  const messages = []
  channel.port1.on('message', message => messages.push(message))
  let counter = 0
  const bridge = createEmbeddedBridge({ target, ready,
    handlers: { applyProject: async project => ({ revision: project.revision }), exportFile: async () => ({ buffer: Uint8Array.from([1, 2, 3]).buffer }),
      dispose: () => ({ disposed: true }), restore: () => {}, setVisible: value => value, ...overrides } })
  const connect = extra => listeners.get('message')({ source: target.parent, origin: target.location.origin,
    data: { type: 'dsh-ez-tree/connect', version: 1, channelId: randomUUID() }, ports: [channel.port2], ...extra })
  const next = async predicate => {
    const deadline = Date.now() + 3000
    while (true) {
      const index = messages.findIndex(predicate)
      if (index >= 0) return messages.splice(index, 1)[0]
      if (Date.now() > deadline) throw new Error('MessagePort response timeout')
      await delay(5)
    }
  }
  t.after(() => { bridge.dispose(); channel.port1.close(); channel.port2.close() })
  return { bridge, target, connect, messages, next, send: message => channel.port1.postMessage(message),
    async call(method, params) {
      const id = ++counter
      channel.port1.postMessage({ id, method, params })
      return next(message => message.id === id)
    } }
}

test('embedded handshake rejects wrong frame/origin/protocol and waits for actual engine readiness', async t => {
  let resolveReady
  const waiting = new Promise(resolve => { resolveReady = resolve })
  const value = fixture(t, {}, () => waiting)
  value.connect({ origin: 'https://unrelated.example' })
  value.connect({ source: {} })
  value.connect({ data: { type: 'dsh-ez-tree/connect', version: 2, channelId: randomUUID() } })
  await delay(15)
  assert.equal(value.messages.length, 0)
  value.connect()
  await delay(15)
  assert.equal(value.messages.length, 0, 'handshake must wait for the real renderer')
  resolveReady()
  const ready = await value.next(message => message.type === 'ready')
  assert.equal(ready.version, 1)
  assert.match(ready.channelId, /^[a-f0-9-]{36}$/)
  await waiting
  const rejected = await value.call('executeJavaScript', { script: 'anything' })
  assert.equal(rejected.ok, false)
})

test('manual mutation blocks export but permits authoritative apply and then accepted intent result', async t => {
  const value = fixture(t)
  value.connect()
  await value.next(message => message.type === 'ready')
  const pending = value.bridge.requestIntent({ expectedRevision: 2, options: { seed: 97531 } })
  const intent = await value.next(message => message.type === 'intent')
  assert.equal(intent.intent.expectedRevision, 2)
  assert.equal((await value.call('exportFile', { format: 'json', revision: 2 })).ok, false)
  assert.deepEqual((await value.call('applyProject', { revision: 3 })).result, { revision: 3 })
  value.send({ type: 'intent-result', id: intent.id, ok: true, project: { revision: 3 } })
  assert.deepEqual(await pending, { revision: 3 })
  assert.equal(value.bridge.pendingMutation, false)
  const exported = await value.call('exportFile', { format: 'json', revision: 3 })
  assert.equal(exported.ok, true)
  assert.deepEqual([...new Uint8Array(exported.result.buffer)], [1, 2, 3])
})

test('manual export intent can be fulfilled through binary command without permitting an uncommitted mutation', async t => {
  const value = fixture(t)
  value.connect()
  await value.next(message => message.type === 'ready')
  const pending = value.bridge.requestIntent({ expectedRevision: 1, export: { format: 'glb' } })
  const intent = await value.next(message => message.type === 'intent')
  assert.equal(value.bridge.pendingMutation, false)
  assert.equal((await value.call('exportFile', { format: 'glb', revision: 1 })).ok, true)
  value.send({ type: 'intent-result', id: intent.id, ok: true, artifact: { path: '/workspace/tree.glb' } })
  assert.deepEqual(await pending, { path: '/workspace/tree.glb' })
})

test('project snapshots preserve exact seed and reject stale revision, wrong project and partial state', async () => {
  const options = JSON.parse(await readFile(new URL('../vendor/ez-tree/src/lib/presets/ash_small.json', import.meta.url)))
  options.seed = 97531
  const project = { projectId: 'session-project', revision: 3, preset: 'Ash Small', options, optionsDigest: hostOptionsDigest(options) }
  const current = validateProject(project, null, options)
  assert.equal(current.options.seed, 97531)
  assert.throws(() => validateProject({ ...project, revision: 2 }, current, options), /过期/)
  assert.throws(() => validateProject({ ...project, projectId: 'other-session' }, current, options), /不匹配/)
  assert.throws(() => validateProject({ ...project, options: { seed: 5 } }, current, options), /缺少参数/)
  assert.equal(validateProject({ ...project, revision: 2, force: true }, current, options).revision, 2)
  assert.deepEqual(optionChanges(options, { ...options, seed: 24680 }), { seed: 24680 })
})

test('browser digest independently matches Host canonical hash and rejects post-render parameter clamping', async () => {
  const actual = { seed: 97531, leaves: { size: 1.75, type: 'pine' }, branch: { levels: 2 } }
  const project = { optionsDigest: hostOptionsDigest(actual) }
  assert.equal(await actualOptionsDigest(actual), project.optionsDigest)
  assert.equal(await actualOptionsDigest({ branch: { levels: 2 }, leaves: { type: 'pine', size: 1.75 }, seed: 97531 }), project.optionsDigest)
  assert.equal(await verifyProjectOptions(project, actual), project.optionsDigest)
  await assert.rejects(verifyProjectOptions(project, { ...actual, seed: 65536 }), /摘要不一致/)
  await assert.rejects(verifyProjectOptions({ optionsDigest: '0'.repeat(64) }, actual), /摘要不一致/)
})
