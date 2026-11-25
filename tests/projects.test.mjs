import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as pause } from 'node:timers/promises'
import { ProjectStore } from '../plugin/projects.mjs'

const scope = { accountId: 'account-one', epoch: 1 }
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ez-tree-projects-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new ProjectStore({ home: join(root, 'home'), renderTimeoutMs: 300, watchTimeoutMs: 50, ...options })
  t.after(async () => { store.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, workspace, store }
}
async function command(store, session = 'session-one') {
  for (let n = 0; n < 100; n++) {
    const state = await store.read(scope, session)
    if (state.command) return state.command
    await pause(2)
  }
  throw new Error('No renderer command')
}
async function ack(store, value, session = 'session-one') {
  return store.ack(scope, session, { operationId: value.operationId, revision: value.project.revision,
    optionsDigest: value.project.optionsDigest, metrics: { vertexCount: 1000, triangleCount: 800 } })
}
async function open(store, workspace, session = 'session-one') {
  const pending = store.open(scope, session, { workspace })
  await ack(store, await command(store, session), session)
  return pending
}

test('opening requires a real render acknowledgement and persists one account/session project', async t => {
  const { root, workspace, store } = await fixture(t)
  assert.equal((await store.read(scope, 'session-one')).project, null)
  const pending = store.open(scope, 'session-one', { workspace })
  const requested = await command(store)
  assert.equal(requested.kind, 'apply')
  assert.equal((await store.read(scope, 'session-one')).project, null, 'unconfirmed initial project is not committed')
  let resolved = false
  pending.then(() => { resolved = true })
  await pause(5)
  assert.equal(resolved, false)
  await ack(store, requested)
  const result = await pending
  assert.equal(result.rendered, true)
  assert.equal(result.project.revision, 0)
  assert.equal(result.presets.length, 15)
  const restarted = new ProjectStore({ home: join(root, 'home') })
  t.after(() => restarted.dispose())
  assert.equal((await restarted.read(scope, 'session-one')).project.projectId, result.project.projectId)
  assert.equal((await store.read({ accountId: 'another', epoch: 1 }, 'session-one')).project, null)
  assert.equal((await store.read(scope, 'different-session')).project, null)
})

test('manual and tool mutations share committed revisions; stale edit cannot overwrite another edit', async t => {
  const { workspace, store } = await fixture(t)
  const original = await open(store, workspace)
  const first = store.edit(scope, 'session-one', { expectedRevision: 0, options: { seed: 97531 } })
  const second = store.edit(scope, 'session-one', { expectedRevision: 0, options: { seed: 999 } })
  const conflict = assert.rejects(second, { code: 'revisionConflict' })
  const next = await command(store)
  assert.equal(next.project.options.seed, 97531)
  assert.equal((await store.read(scope, 'session-one')).project.options.seed, original.project.options.seed)
  await ack(store, next)
  assert.equal((await first).project.revision, 1)
  await conflict
  assert.equal((await store.read(scope, 'session-one')).project.options.seed, 97531)
  await assert.rejects(store.edit(scope, 'session-one', { options: { renderer: 'arbitrary' } }), /未知/)
})

test('renderer failure and cancellation preserve prior project and release pending waiters', async t => {
  const { workspace, store } = await fixture(t)
  const previous = (await open(store, workspace)).project
  const changed = store.edit(scope, 'session-one', { options: { seed: 12345 } })
  const rejection = assert.rejects(changed, { code: 'rendererFailed' })
  const active = await command(store)
  await store.fail(scope, 'session-one', active.operationId, 'WebGL unavailable')
  await rejection
  assert.deepEqual((await store.read(scope, 'session-one')).project, previous)
  const controller = new AbortController()
  const changedAgain = store.edit(scope, 'session-one', { options: { seed: 10 }, signal: controller.signal })
  const aborted = assert.rejects(changedAgain, { name: 'AbortError' })
  await command(store)
  controller.abort()
  await aborted
  assert.deepEqual((await store.read(scope, 'session-one')).project, previous)
  await assert.rejects(store.ack(scope, 'session-one', { operationId: active.operationId }), { code: 'staleOperation' })
})

test('exports accept only the pending revision, preserve source options, and never overwrite files', async t => {
  const { workspace, store } = await fixture(t)
  const project = (await open(store, workspace)).project
  const result = store.export(scope, 'session-one', { format: 'json', name: 'tree-project' })
  const request = await command(store)
  assert.equal(request.kind, 'export')
  const bytes = Buffer.from(JSON.stringify(project.options))
  await assert.rejects(store.upload(scope, 'session-one', 'wrong-operation', bytes), { code: 'staleOperation' })
  const artifact = await store.upload(scope, 'session-one', request.operationId, bytes)
  assert.equal((await result).path, artifact.path)
  assert.equal(artifact.revision, project.revision)
  assert.deepEqual(JSON.parse(await readFile(artifact.path, 'utf8')), project.options)
  assert.equal(artifact.path, join(workspace, 'models/ez-tree/tree-project.json'))
  const duplicate = store.export(scope, 'session-one', { format: 'json', name: 'tree-project' })
  const rejected = assert.rejects(duplicate)
  const duplicateCommand = await command(store)
  await assert.rejects(store.upload(scope, 'session-one', duplicateCommand.operationId, bytes), { code: 'EEXIST' })
  await store.fail(scope, 'session-one', duplicateCommand.operationId, 'File already exists')
  await rejected
  await assert.rejects(store.export(scope, 'session-one', { format: 'json', name: '../escape' }), /文件名/)
})

test('new epochs cancel an old render; no GUI acknowledgement means explicit failure', async t => {
  const { workspace, store } = await fixture(t, { renderTimeoutMs: 30 })
  await assert.rejects(store.open(scope, 'session-one', { workspace }), { code: 'rendererUnavailable' })
  assert.equal((await store.read(scope, 'session-one')).project, null)
  await open(store, workspace)
  const pending = store.edit(scope, 'session-one', { options: { seed: 222 } })
  const rejected = assert.rejects(pending, { code: 'identityChanged' })
  await command(store)
  await store.read({ ...scope, epoch: 2 }, 'session-one')
  await rejected
  assert.notEqual((await store.read({ ...scope, epoch: 2 }, 'session-one')).project.options.seed, 222)
})
