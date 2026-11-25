import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ProjectStore } from '../plugin/projects.mjs'
import { registerNativeEditor } from '../plugin/session-host.mjs'

const owner = { principal: { kind: 'owner' } }
const newSkill = '---\nname: ez-tree\ndescription: 当前会话三维树木编辑\n---\nCall ez_tree_open_editor, then generate and export the shared project.\n'
const oldSkill = '---\nname: ez-tree\ndescription: 旧版技能\n---\nUse the old MCP.\n'

async function fixture(t, { managed = false, customized = false, native = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ez-tree-session-host-'))
  let workspace = join(root, 'workspace'), account = { accountId: 'account-a', epoch: 1 }
  await mkdir(workspace)
  const skillPath = join(root, 'skill/SKILL.md'), legacySkillPath = join(root, 'legacy.md')
  await mkdir(join(root, 'skill')); await writeFile(skillPath, newSkill); await writeFile(legacySkillPath, oldSkill)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() { return () => {} } })
  new ToolsService(ctx)
  const providers = new Map(), observers = new Set(), skillCalls = []
  let legacyEnabled = managed || customized
  const skills = {
    registerProvider(factory) {
      const controller = new AbortController()
      const provider = factory({ signal: controller.signal, invalidate() {} })
      providers.set(provider.name, provider)
      return () => { providers.delete(provider.name); controller.abort() }
    },
    async list(options = {}) {
      const candidates = []
      if (legacyEnabled) candidates.push({ name: 'ez-tree', provider: 'custom-user', rank: 300 })
      for (const provider of providers.values()) candidates.push(...await provider.list(options))
      return candidates.sort((a, b) => a.rank - b.rank).filter((candidate, index, all) => all.findIndex(value => value.name === candidate.name) === index)
    },
  }
  ctx.provide('skills', skills)
  const agent = { id: 'session-one' }
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
  ctx.provide('workingDirectory', { ensure: async current => { assert.equal(current, agent); return workspace } })
  if (!native) ctx.provide('sealHarnessIdentity', { getSession: () => account,
    subscribe: listener => { observers.add(listener); return () => observers.delete(listener) } })
  if (managed) ctx.provide('sealHarnessSkills', { async call(action, payload) {
    skillCalls.push({ action, payload })
    if (action === 'list') return { revision: 7, skills: [{ id: 'old-copy', name: 'ez-tree', installed: true, enabled: legacyEnabled, origin: { kind: 'local' } }] }
    if (action === 'detail') return { rawContent: customized ? oldSkill + 'User changes\n' : oldSkill }
    if (action === 'setEnabled') { assert.equal(payload.enabled, false); assert.equal(payload.expectedRevision, 7); legacyEnabled = false; return {} }
    throw new Error(`Unexpected ${action}`)
  } })
  const store = new ProjectStore({ home: join(root, 'home'), renderTimeoutMs: 700, watchTimeoutMs: 25 })
  const editor = registerNativeEditor(ctx, { store, skillPath, legacySkillPath, routes: false })
  await editor.ready
  await pause(0)
  t.after(async () => { await editor.dispose(); store.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, ctx, store, editor, agent, providers, skills, skillCalls, tool: name => ctx.tools.get(name),
    execute: (name, args = {}) => ctx.tools.get(name).execute(args, { agent, signal: new AbortController().signal }),
    call: (action, payload) => editor.handle(action, payload, new AbortController().signal, owner),
    setAccount(value) { account = value; for (const observer of [...observers]) observer() },
    async changeWorkspace() { workspace = join(root, 'different'); await mkdir(workspace); return workspace },
  }
}

async function nextCommand(f, previousId) {
  for (let count = 0; count < 150; count++) {
    const snapshot = await f.store.read(f.editor.scope(), f.agent.id)
    if (snapshot.command && snapshot.command.operationId !== previousId) return snapshot.command
    await pause(2)
  }
  throw new Error('No renderer command')
}
async function acknowledge(f, command) {
  const result = await f.call('editorAck', { sessionId: f.agent.id, operationId: command.operationId,
    revision: command.project.revision, optionsDigest: command.project.optionsDigest, metrics: { vertexCount: 1000, triangleCount: 800 } })
  assert.equal(result.ok, true, result.error?.message)
}
async function open(f) {
  const pending = f.execute('ez_tree_open_editor')
  await acknowledge(f, await nextCommand(f))
  return JSON.parse(await pending)
}

test('real native ToolsService accepts executable SDK schemas and builtin skill provider without an MCP install', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.ctx.tools.schemas().map(value => value.name).sort(), ['ez_tree_editor_export', 'ez_tree_editor_generate', 'ez_tree_editor_get', 'ez_tree_open_editor'])
  assert.equal(f.tool('ez_tree_editor_generate').parameters.properties.options.additionalProperties, true)
  assert.equal(f.tool('ez_tree_editor_export').output.schema.type, 'string')
  const [candidate] = await f.skills.list()
  assert.equal(candidate.name, 'ez-tree'); assert.equal(candidate.rank, 600)
  const definition = await f.providers.get(candidate.provider).get(candidate, {})
  assert.match(definition.content, /ez_tree_open_editor/)
  await assert.rejects(f.execute('ez_tree_editor_export', {}))
  await assert.rejects(f.tool('ez_tree_open_editor').execute({}, { signal: new AbortController().signal }), /当前会话/)
  await assert.rejects(lstat(join(f.root, 'home/ez-tree')), { code: 'ENOENT' })
})

test('session tool open remains pending until actual ack and manual/tool edits share committed revisions', async t => {
  const f = await fixture(t)
  const first = await open(f)
  assert.equal(first.rendered, true)
  const generating = f.execute('ez_tree_editor_generate', { expectedRevision: 0, options: { seed: 321 } })
  const reopened = await nextCommand(f)
  await acknowledge(f, reopened)
  const generated = await nextCommand(f, reopened.operationId)
  assert.equal(generated.project.options.seed, 321)
  await acknowledge(f, generated)
  assert.equal(JSON.parse(await generating).project.revision, 1)
  const editing = f.call('editorEdit', { sessionId: f.agent.id, expectedRevision: 1, options: { seed: 654 } })
  await acknowledge(f, await nextCommand(f))
  assert.equal((await editing).value.project.revision, 2)
  const latest = JSON.parse(await f.execute('ez_tree_editor_get'))
  assert.equal(latest.project.options.seed, 654)
  assert.equal((await f.call('editorEdit', { sessionId: f.agent.id, expectedRevision: 1, options: { seed: 999 } })).error.code, 'revisionConflict')
})

test('RPC ownership/CAS/session payload checks reject arbitrary account and workspace; read does not create a project', async t => {
  const f = await fixture(t)
  const read = await f.call('editorRead', { sessionId: 'unopened' })
  assert.equal(read.value.project, null)
  assert.equal(typeof read.value.accountScope, 'string')
  await assert.rejects(lstat(join(f.root, 'home/ez-tree')), { code: 'ENOENT' })
  assert.equal((await f.call('editorRead', { sessionId: f.agent.id, accountId: 'other' })).error.code, 'invalidInput')
  assert.equal((await f.call('editorEdit', { sessionId: f.agent.id, options: { seed: 1 } })).error.code, 'invalidInput')
  const denied = await f.editor.handle('editorRead', { sessionId: f.agent.id }, undefined, { principal: { kind: 'remote' } })
  assert.equal(denied.error.code, 'forbidden')
})

test('UI writes reject a changed directory until a trusted tool reopens the project in the new workspace', async t => {
  const f = await fixture(t)
  await open(f)
  const changed = await f.changeWorkspace()
  assert.equal((await f.call('editorExport', { sessionId: f.agent.id, format: 'json' })).error.code, 'workspaceChanged')
  const result = await open(f)
  assert.equal(result.project.workspace.toLowerCase(), (await realpath(changed)).toLowerCase())
})

test('account epoch changes cancel renderer waiters and clear the old account view', async t => {
  const f = await fixture(t)
  const old = await f.call('editorRead', { sessionId: f.agent.id })
  const pending = f.execute('ez_tree_open_editor')
  const failed = assert.rejects(pending, { code: 'identityChanged' })
  await nextCommand(f)
  f.setAccount({ accountId: 'account-b', epoch: 2 })
  await failed
  const current = await f.call('editorRead', { sessionId: f.agent.id })
  assert.equal(current.value.project, null)
  assert.notEqual(current.value.accountScope, old.value.accountScope)
})

test('only the exact known managed legacy skill is disabled; customized skills remain untouched and diagnosed', async t => {
  const known = await fixture(t, { managed: true })
  assert.equal(known.editor.compatibility().state, 'legacyDisabled')
  assert.equal(known.skillCalls.filter(value => value.action === 'setEnabled').length, 1)
  const customized = await fixture(t, { managed: true, customized: true })
  assert.equal(customized.editor.compatibility().state, 'customSkillShadow')
  assert.equal(customized.skillCalls.some(value => value.action === 'setEnabled'), false)
  const native = await fixture(t, { native: true, customized: true })
  assert.equal(native.editor.compatibility().state, 'customSkillShadow')
  assert.equal(native.skillCalls.length, 0)
})

test('cancelled long-poll keeps the native string error-code contract and disposal unregisters contributions', async t => {
  const f = await fixture(t)
  const current = await f.call('editorRead', { sessionId: f.agent.id })
  const controller = new AbortController()
  const watching = f.editor.handle('editorWatch', { sessionId: f.agent.id, afterCursor: current.value.cursor }, controller.signal, owner)
  await pause(2)
  controller.abort()
  const result = await watching
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'cancelled')
  assert.equal(typeof result.error.code, 'string')
  await f.editor.dispose()
  assert.equal(f.ctx.tools.schemas().length, 0)
  assert.equal(f.providers.size, 0)
  assert.equal((await f.call('editorRead', { sessionId: f.agent.id })).error.code, 'disposed')
})

test('the first render can be acknowledged or failed before any project is committed', async t => {
  const f = await fixture(t)
  const opening = f.execute('ez_tree_open_editor')
  const command = await nextCommand(f)
  const pending = await f.call('editorRead', { sessionId: f.agent.id })
  assert.equal(pending.value.project, null)
  assert.equal(pending.value.command.operationId, command.operationId)
  assert.equal((await f.call('editorEdit', { sessionId: f.agent.id, expectedRevision: 0, options: { seed: 9 } })).error.code, 'projectMissing')
  await acknowledge(f, command)
  assert.equal(JSON.parse(await opening).rendered, true)
  const g = await fixture(t)
  const failedOpening = g.execute('ez_tree_open_editor')
  const rejected = assert.rejects(failedOpening, { code: 'rendererFailed' })
  const failedCommand = await nextCommand(g)
  const result = await g.call('editorFail', { sessionId: g.agent.id, operationId: failedCommand.operationId, message: 'WebGL unavailable' })
  assert.equal(result.value.accepted, true)
  await rejected
  assert.equal((await g.call('editorRead', { sessionId: g.agent.id })).value.project, null)
})

test('an owner launches a session-bound browser page and its cookie-authenticated ACK settles the same tool', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('editorBrowserLaunch', { sessionId: f.agent.id })).error.code, 'projectMissing')
  const opening = f.execute('ez_tree_open_editor')
  await nextCommand(f)
  const launched = await f.call('editorBrowserLaunch', { sessionId: f.agent.id })
  assert.equal(launched.ok, true)
  const url = new URL(launched.value.url), token = new URLSearchParams(url.hash.slice(1)).get('bootstrap')
  url.hash = ''
  async function page(method, payload, cookie) {
    return fetch(new URL('./api/' + method, url), { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(payload) })
  }
  const redeemed = await page('redeem', { token })
  assert.equal(redeemed.status, 200)
  const cookie = redeemed.headers.get('set-cookie').split(';')[0]
  assert.equal((await page('read', { sessionId: 'other' }, cookie)).status, 400)
  const read = await page('read', {}, cookie), state = (await read.json()).value
  assert.equal(state.project, null)
  assert.equal(state.command.project.sessionId, f.agent.id)
  const command = state.command
  const acknowledged = await page('ack', { operationId: command.operationId, revision: command.project.revision, optionsDigest: command.project.optionsDigest,
    metrics: { vertexCount: 1000, triangleCount: 800 } }, cookie)
  assert.equal(acknowledged.status, 200)
  assert.equal(JSON.parse(await opening).rendered, true)
  assert.equal((await f.call('editorRead', { sessionId: f.agent.id })).value.browserView.leaseId, launched.value.leaseId)
  f.setAccount({ accountId: 'account-b', epoch: 2 })
  assert.equal((await page('read', {}, cookie)).status, 401)
})
