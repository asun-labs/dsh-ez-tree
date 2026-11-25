import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 文件没有 JSX/React：直接加载产品模块，避免用重写实现验证自身。
const source = await readFile(new URL('../plugin/client.jsx', import.meta.url), 'utf8')
const { createBuiltinBrowserLauncher, apply, inject } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const command = operationId => ({ operationId, kind: 'apply', project: { projectId: 'project-a' } })

function fixture({ launch, brokenBrowser = false, inventory = true } = {}) {
  let sid = 'a', scope = 'scope-a', clock = 100000, serial = 0, lease = 0
  const listeners = new Set(), calls = [], watches = [], opened = [], focused = [], tabs = [], active = new Map(), errors = []
  const sidebarRight = {
    mounted: { getSnapshot: () => sid, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } },
    ...(inventory ? { openTabs: { getSnapshot: () => tabs.map(tab => ({ sessionId: tab.sessionId, tabId: tab.id, kind: tab.kind })) } } : {}),
    active: () => active.get(sid),
    focus(id) { focused.push({ sid, id }); const tab = tabs.find(tab => tab.id === id && tab.sessionId === sid); if (tab) active.set(sid, tab) },
    openTab(kind, options) {
      if (brokenBrowser) throw new Error('Browser kind is unavailable')
      if (options.replaceTab) { const index = tabs.findIndex(tab => tab.id === options.replaceTab); if (index >= 0) tabs.splice(index, 1) }
      const tab = { id: `tab-${++serial}`, kind, sessionId: sid }
      tabs.push(tab); active.set(sid, tab); opened.push({ sid, kind, options, tab })
    },
  }
  const ctx = { sidebarRight, connection: { rpc: { async call(channel, action, payload, signal) {
    assert.equal(channel, '/dsh-ez-tree'); calls.push({ action, payload, signal })
    if (action === 'editorWatch') { const d = deferred(); watches.push({ ...d, sid: payload.sessionId, signal }); signal.addEventListener('abort', () => d.resolve({ ok: false, error: { message: 'aborted' } }), { once: true }); return d.promise }
    if (action === 'editorBrowserLaunch') return { ok: true, value: await (launch?.(payload) ?? { url: `http://127.0.0.1:4321/editor#ticket=private-${++lease}`, leaseId: `lease-${lease}`, accountScope: scope }) }
    return { ok: true, value: {} }
  } } } }
  const controller = createBuiltinBrowserLauncher(ctx, { now: () => clock, onError: error => errors.push(error.message), retryDelay: 10 })
  const deliver = async (value, target = sid) => {
    const w = watches.find(w => w.sid === target && !w.delivered)
    assert.ok(w, `missing watch ${target}`); w.delivered = true
    w.resolve({ ok: true, value: { cursor: 1, accountScope: scope, project: null, command: null, browserView: null, ...value } })
    await tick(); await tick()
  }
  return { ctx, controller, calls, watches, opened, focused, tabs, errors, deliver,
    select(next) { sid = next; for (const listener of listeners) listener() },
    changeScope(next) { scope = next }, advance(ms) { clock += ms },
    closeTab(id) { const index = tabs.findIndex(tab => tab.id === id); if (index >= 0) tabs.splice(index, 1); active.delete(sid) },
  }
}

test('apply uses built-in Browser only and declares no panel, tab kind, DOM or iframe', () => {
  const f = fixture(); const release = []
  f.ctx.effect = callback => release.push(callback())
  f.ctx.slots = { inject() { throw Error('custom slot forbidden') } }
  f.ctx.sidebarRightTabs = { register() { throw Error('custom tab forbidden') } }
  try { apply(f.ctx); assert.deepEqual(inject, ['sidebarRight', 'connection']); assert.equal(f.opened.length, 0) }
  finally { release.forEach(dispose => dispose()) }
  assert.ok(!source.includes('<iframe'))
  assert.ok(!source.includes('createSessionEditorController'))
})

test('idle or export-only snapshots do not create browser leases', async () => {
  const f = fixture(); f.controller.start()
  try { await f.deliver({}); await f.deliver({ cursor: 2, command: { operationId: 'export-1', kind: 'export' } }); assert.equal(f.opened.length, 0); assert.equal(f.calls.filter(c => c.action === 'editorBrowserLaunch').length, 0) }
  finally { f.controller.dispose() }
})

test('first apply loads leased URL in browser; later apply focuses same tab without minting another lease', async () => {
  const f = fixture(); f.controller.start()
  try {
    await f.deliver({ command: command('open-1') })
    assert.equal(f.opened.length, 1); assert.equal(f.opened[0].kind, 'browser')
    assert.match(f.opened[0].options.params.url, /^http:\/\/127\.0\.0\.1:4321\/editor#ticket=/)
    assert.deepEqual(f.calls.find(c => c.action === 'editorBrowserLaunch').payload, { sessionId: 'a' })
    await f.deliver({ cursor: 2, command: command('open-1'), browserView: { leaseId: 'lease-1', connected: false } })
    assert.equal(f.opened.length, 1, 'initial loading grace avoids replacing new view')
    await f.deliver({ cursor: 3, command: command('generate-2'), browserView: { leaseId: 'lease-1', connected: true } })
    assert.equal(f.calls.filter(c => c.action === 'editorBrowserLaunch').length, 1)
    assert.equal(f.opened.length, 1); assert.equal(f.focused.at(-1).id, 'tab-1')
  } finally { f.controller.dispose() }
})

test('closed tab stays closed during same operation; next tool invocation obtains fresh view', async () => {
  const f = fixture(); f.controller.start()
  try {
    await f.deliver({ command: command('open-1') }); f.closeTab('tab-1'); f.advance(20000)
    await f.deliver({ cursor: 2, command: command('open-1') })
    assert.equal(f.opened.length, 1)
    await f.deliver({ cursor: 3, command: command('open-2') })
    assert.equal(f.opened.length, 2); assert.equal(f.tabs.length, 1)
    assert.equal(f.calls.filter(c => c.action === 'editorBrowserLaunch').length, 2)
  } finally { f.controller.dispose() }
})

test('navigated-away view is replaced through public replaceTab after presence grace', async () => {
  const f = fixture(); f.controller.start()
  try {
    await f.deliver({ command: command('open-1') }); f.advance(20000)
    await f.deliver({ cursor: 2, command: command('open-1'), browserView: { leaseId: 'lease-1', connected: false } })
    assert.equal(f.opened[1].options.replaceTab, 'tab-1')
    assert.equal(f.tabs.length, 1)
    await f.deliver({ cursor: 3, command: command('open-1'), browserView: { leaseId: 'lease-2', connected: false } })
    assert.equal(f.opened.length, 2)
  } finally { f.controller.dispose() }
})

test('session change while launching never opens old view in new session', async () => {
  const pending = deferred(), f = fixture({ launch: () => pending.promise }); f.controller.start()
  try {
    await f.deliver({ command: command('open-1') }); f.select('b')
    pending.resolve({ url: 'http://127.0.0.1/editor#private', leaseId: 'late', accountScope: 'scope-a' })
    await tick(); assert.equal(f.opened.length, 0)
    assert.equal(f.calls.find(c => c.action === 'editorBrowserLaunch').signal.aborted, true)
  } finally { f.controller.dispose() }
})

test('cancelled pending operation does not open a tab when late lease reply arrives', async () => {
  const pending = deferred(), f = fixture({ launch: () => pending.promise }); f.controller.start()
  try {
    await f.deliver({ command: command('open-1') }); await f.deliver({ cursor: 2, command: null })
    pending.resolve({ url: 'http://127.0.0.1/editor#private', leaseId: 'late', accountScope: 'scope-a' })
    await tick(); assert.equal(f.opened.length, 0)
  } finally { f.controller.dispose() }
})

test('account change invalidates cached lease without focusing previous account tab', async () => {
  const f = fixture(); f.controller.start()
  try {
    await f.deliver({ command: command('open-1') })
    f.changeScope('scope-b')
    await f.deliver({ cursor: 2, command: command('open-b') })
    assert.equal(f.opened.length, 2); assert.equal(f.focused.length, 0)
    assert.equal(f.opened[1].options.replaceTab, undefined, 'do not alter another account cached tab')
  } finally { f.controller.dispose() }
})

test('mismatched lease scope fails operation and never passes URL into browser', async () => {
  const f = fixture({ launch: async () => ({ url: 'http://127.0.0.1/editor#secret', leaseId: 'bad', accountScope: 'other' }) }); f.controller.start()
  try { await f.deliver({ command: command('open-1') }); assert.equal(f.opened.length, 0); assert.equal(f.calls.find(c => c.action === 'editorFail').payload.operationId, 'open-1') }
  finally { f.controller.dispose() }
})

test('unavailable built-in Browser returns honest tool failure instead of fallback panel', async () => {
  const f = fixture({ brokenBrowser: true }); f.controller.start()
  try { await f.deliver({ command: command('open-1') }); assert.match(f.errors[0], /Browser/); assert.equal(f.calls.filter(c => c.action === 'editorFail').length, 1) }
  finally { f.controller.dispose() }
})
