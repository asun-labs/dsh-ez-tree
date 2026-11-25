import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, apply } from '../plugin/index.mjs'
import { Readable } from 'node:stream'
import { VERSION } from '../version.mjs'

const owner = { principal: { kind: 'owner' } }

function fixture({ authenticated = true, native = false, blockInstall = false } = {}) {
  let account = authenticated ? { accountId: 'account-a', epoch: 1 } : null
  let identityListener
  const managers = []
  class Manager {
    constructor(options) { this.options = options; this.installed = false; this.running = false; this.stops = 0; managers.push(this) }
    async status() { return { installed: this.installed, running: this.running, version: VERSION, targetVersion: VERSION, updateAvailable: false, available: true, supported: true, dataDirectory: '/data' } }
    async install() {
      if (blockInstall) await new Promise((resolve, reject) => this.options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
      this.options.signal.throwIfAborted(); this.installed = true
    }
    async launch() { this.options.signal.throwIfAborted(); this.running = true }
    async stop() { this.stops++; this.running = false }
    async uninstall() { this.installed = false }
    async descriptor() { return { command: '/app/ez-tree.exe', args: ['/app/resources/app/lib/mcp/cli.mjs', '--account', this.options.accountId], env: { ELECTRON_RUN_AS_NODE: '1' }, cwd: '/data', version: VERSION } }
  }
  const connectorCalls = []
  const records = []
  const connectors = { async call(action, payload) {
    connectorCalls.push({ action, payload })
    if (action === 'createDraft') records.push({ ...payload, revision: 0, installed: false, enabled: false, ownerAccountId: account.accountId })
    if (action === 'installPersonal') {
      const entry = records.find(value => value.id === payload.id)
      assert.equal(payload.revision, entry.revision)
      entry.installed = true; entry.revision++
    }
    if (action === 'save') {
      const entry = records.find(value => value.id === payload.id)
      assert.equal(payload.revision, entry.revision)
      Object.assign(entry, payload, { env: Object.keys(payload.envValues ?? {}), revision: entry.revision + 1 })
    }
    return { items: structuredClone(records) }
  } }
  const skillCalls = []
  const installedSkills = []
  const skills = { async call(action, payload) {
    skillCalls.push({ action, payload })
    if (action === 'create') installedSkills.push({ id: 'skill-1', name: 'ez-tree', enabled: payload.enable, installed: true })
    return { revision: installedSkills.length, skills: structuredClone(installedSkills) }
  } }
  const services = native ? {} : {
    sealHarnessIdentity: { getSession: () => account, subscribe: listener => { identityListener = listener; return () => { identityListener = undefined } } },
    sealHarnessConnectors: connectors, sealHarnessSkills: skills,
  }
  const ctx = { get: key => services[key], logger: { info() {}, warn() {} } }
  const host = createHost(ctx, { Manager, loadSkill: async () => '---\nname: ez-tree\ndescription: Generate tree models\n---\nUse EZ-Tree.' })
  return { host, services, managers, connectorCalls, records, skillCalls, installedSkills,
    changeAccount(value) { account = value; identityListener?.() }, call: (action, payload = {}, peer = owner) => host.handle(action, payload, undefined, peer) }
}

test('owner boundary rejects remote management and payload paths before creating runtime', async () => {
  const f = fixture()
  assert.equal((await f.call('install', {}, { principal: { kind: 'remote' } })).error.code, 'forbidden')
  assert.equal((await f.call('open', { path: 'C:/untrusted.exe' })).error.code, 'invalidInput')
  assert.equal(f.managers.length, 0)
  await f.host.dispose()
})

test('Seal logout rejects management while native DSH uses local owner namespace', async () => {
  const seal = fixture({ authenticated: false })
  assert.equal((await seal.call('install')).error.code, 'authenticationRequired')
  assert.equal(seal.managers.length, 0)
  const native = fixture({ native: true })
  const result = await native.call('install')
  assert.equal(result.ok, true)
  assert.equal(result.value.identityMode, 'local')
  assert.equal(native.managers[0].options.accountId, 'local-owner')
  const config = await native.call('prepareMcp')
  assert.equal(config.value.registered, false)
  assert.deepEqual(config.value.config.args, ['/app/resources/app/lib/mcp/cli.mjs', '--account', 'local-owner'])
  assert.deepEqual(config.value.config.env, { ELECTRON_RUN_AS_NODE: '1' })
  await Promise.all([seal.host.dispose(), native.host.dispose()])
})

test('MCP is account-owned, installed disabled and repeated preparation is idempotent', async () => {
  const f = fixture()
  assert.equal((await f.call('prepareMcp')).ok, true)
  assert.deepEqual(f.connectorCalls.map(value => value.action), ['list', 'createDraft', 'save', 'installPersonal'])
  const entry = f.records[0]
  assert.equal(entry.ownerAccountId, 'account-a')
  assert.equal(entry.enabled, false)
  assert.equal(entry.installed, true)
  assert.equal(f.connectorCalls.some(value => value.action === 'setEnabled'), false)
  assert.deepEqual(f.connectorCalls.find(value => value.action === 'save').payload.envValues, { ELECTRON_RUN_AS_NODE: '1' })
  const repeated = await f.call('prepareMcp')
  assert.equal(repeated.value.connectorId, entry.id)
  assert.equal(f.connectorCalls.filter(value => value.action === 'createDraft').length, 1)
  assert.equal(f.connectorCalls.filter(value => value.action === 'save').length, 1)
  await f.host.dispose()
})

test('bundled skill imports into current account without silently enabling or overwriting it', async () => {
  const f = fixture()
  f.installedSkills.push({ id: 'unrelated-skill', name: 'other-skill', installed: true, enabled: true })
  const result = await f.call('installSkill')
  assert.equal(result.value.installed, true)
  assert.equal(result.value.skillId, 'skill-1')
  const create = f.skillCalls.find(value => value.action === 'create').payload
  assert.equal(create.enable, false)
  assert.equal(create.expectedRevision, 1)
  assert.match(create.content, /name: ez-tree/)
  f.installedSkills.find(skill => skill.name === 'ez-tree').enabled = true
  const repeated = await f.call('installSkill')
  assert.equal(repeated.value.enabled, true)
  assert.equal(f.skillCalls.filter(value => value.action === 'create').length, 1)
  await f.host.dispose()
})

test('MCP preparation refreshes a changed pinned runtime environment and disables the previous connector', async () => {
  const f = fixture()
  await f.call('prepareMcp')
  f.records[0].enabled = true
  const descriptor = await f.managers[0].descriptor()
  f.managers[0].descriptor = async () => ({ ...descriptor, env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: '/new-home' } })
  const result = await f.call('prepareMcp')
  assert.equal(result.ok, true)
  assert.equal(result.value.enabled, false)
  const updates = f.connectorCalls.filter(call => call.action === 'save')
  assert.equal(updates.length, 2)
  assert.deepEqual(updates[1].payload.envValues, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: '/new-home' })
  await f.host.dispose()
})

test('uninstall refuses an enabled owned MCP and preserves unrelated connector configuration', async () => {
  const f = fixture()
  await f.call('install')
  await f.call('prepareMcp')
  f.records[0].enabled = true
  f.records.push({ id: 'other-connector', enabled: true })
  const blocked = await f.call('uninstall')
  assert.equal(blocked.error.code, 'connectorEnabled')
  assert.match(blocked.error.message, /连接器页面停用 EZ-Tree/)
  assert.equal(f.managers[0].installed, true)
  f.records[0].enabled = false
  const removed = await f.call('uninstall')
  assert.equal(removed.ok, true)
  assert.equal(f.managers[0].installed, false)
  assert.equal(f.records.length, 2)
  assert.equal(f.records[1].enabled, true)
  assert.equal(f.connectorCalls.some(value => value.action === 'remove' || value.action === 'setEnabled'), false)
  await f.host.dispose()
})

test('identity changes abort in-flight installation and stop the previous account runtime', async () => {
  const f = fixture({ blockInstall: true })
  f.host.watchIdentity()
  const pending = f.call('install')
  const during = await f.call('status')
  assert.equal(during.value.busy, 'install')
  assert.equal((await f.call('open')).error.code, 'busy')
  f.changeAccount({ accountId: 'account-b', epoch: 2 })
  const result = await pending
  assert.equal(result.error.code, 'cancelled')
  assert.equal(f.managers[0].options.signal.aborted, true)
  assert.equal(f.managers[0].stops, 1)
  const next = await f.call('status')
  assert.equal(next.ok, true)
  assert.notEqual(next.value.accountScope, during.value.accountScope)
  assert.equal(f.managers[1].options.accountId, 'account-b')
  await f.host.dispose()
})

test('same-account epoch changes invalidate previous lifecycle and plugin unload rejects new work', async () => {
  const f = fixture()
  f.host.watchIdentity()
  await f.call('open')
  f.changeAccount({ accountId: 'account-a', epoch: 3 })
  assert.equal(f.managers[0].options.signal.aborted, true)
  assert.equal(f.managers[0].running, false)
  await f.host.dispose()
  assert.equal((await f.call('open')).error.code, 'disposed')
})

test('host registers an authenticated owner-checked RPC route and disposable optional identity hook', async () => {
  let registered
  const disposers = []
  let injection
  const services = { tools: { register: () => () => {} }, skills: { registerProvider: () => () => {}, list: async () => [] },
    workingDirectory: { ensure: async () => '/workspace' } }
  const ctx = { connection: { admit: () => ({ peer: { principal: { kind: 'remote' } } }) },
    webServer: { register: route => { registered = route; return () => {} } },
    get: key => services[key], inject: (keys, callback) => { injection = { keys, callback } },
    effect: setup => { disposers.push(setup()) } }
  apply(ctx)
  assert.equal(registered.path, '/dsh-ez-tree')
  assert.deepEqual(injection.keys, ['sealHarnessIdentity'])
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'status', payload: {} }))]),
    { url: '/dsh-ez-tree/status', method: 'POST', headers: { 'content-type': 'application/json' } })
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await registered.handler(request, response)
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).result.error.code, 'forbidden')
  ctx.connection.admit = () => ({ rejection: 403 })
  await registered.handler(request, response)
  assert.equal(response.status, 403)
  for (const dispose of disposers.reverse()) await dispose?.()
})
