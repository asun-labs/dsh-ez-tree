/** Open the editor in the application's existing Browser tab; no plugin-owned panel. */
export const inject = ['sidebarRight', 'connection']

const CHANNEL = '/dsh-ez-tree'
const messageOf = error => typeof error === 'string' ? error : error?.message || '右侧浏览器打开失败。'
const wait = (milliseconds, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve()
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
  const timer = setTimeout(finish, milliseconds)
  signal.addEventListener('abort', finish, { once: true })
})

export function createBuiltinBrowserLauncher(ctx, { now = Date.now, retryDelay = 1000, startupGrace = 15000,
  onError = error => ctx.logger?.warn?.(`EZ Tree：${messageOf(error)}`) } = {}) {
  const entries = new Map()
  let currentId, watching, disposed = false, started = false, accountScope, unsubscribe, unsubscribeGeneration
  const entryFor = sessionId => {
    if (!entries.has(sessionId)) entries.set(sessionId, { sessionId, cursor: 0, tabId: null, leaseId: null,
      scope: undefined, command: null, view: null, seen: new Set(), pending: false, openedAt: 0, actions: new AbortController() })
    return entries.get(sessionId)
  }
  const isCurrent = entry => !disposed && currentId === entry.sessionId && ctx.sidebarRight.mounted.getSnapshot() === entry.sessionId
  async function rpc(action, payload, signal) {
    const response = await ctx.connection.rpc.call(CHANNEL, action, payload, signal)
    if (!response?.ok) throw new Error(messageOf(response?.error))
    return response.value
  }
  function clear() {
    for (const entry of entries.values()) {
      entry.actions.abort(); entry.actions = new AbortController()
      entry.cursor = 0; entry.command = null; entry.tabId = null; entry.leaseId = null; entry.scope = undefined
      entry.view = null; entry.seen.clear(); entry.openedAt = 0
    }
  }
  function observeScope(value) {
    if (typeof value.accountScope !== 'string' || !value.accountScope) throw new Error('浏览器会话缺少账号范围。')
    if (accountScope !== undefined && value.accountScope !== accountScope) clear()
    accountScope = value.accountScope
  }
  function inventoryContains(entry) {
    if (!entry.tabId) return false
    // 公开只读清单也覆盖浮动页签，不以当前 dock 页签猜测它是否关闭。
    const tabs = ctx.sidebarRight.openTabs?.getSnapshot()
    if (Array.isArray(tabs)) return tabs.some(tab => tab.sessionId === entry.sessionId && tab.tabId === entry.tabId && tab.kind === 'browser')
    return undefined
  }
  function focusExisting(entry) {
    if (!entry.tabId || inventoryContains(entry) === false) return false
    ctx.sidebarRight.focus(entry.tabId)
    return inventoryContains(entry) ?? ctx.sidebarRight.active()?.id === entry.tabId
  }
  function viewLost(entry) {
    if (now() - entry.openedAt < startupGrace) return false
    return !entry.view || entry.view.leaseId !== entry.leaseId || entry.view.connected === false
  }
  function remember(entry, operationId) {
    entry.seen.add(operationId)
    if (entry.seen.size > 64) entry.seen.delete(entry.seen.values().next().value)
  }
  async function launch(entry) {
    const command = entry.command
    if (!isCurrent(entry) || command?.kind !== 'apply' || entry.pending) return
    const alreadySeen = entry.seen.has(command.operationId)
    const present = inventoryContains(entry)
    if (alreadySeen && !viewLost(entry)) return
    // 用户关闭页签不在同一个操作中反复抢回；下一次技能调用再打开新页。
    if (alreadySeen && present === false) return
    const signal = entry.actions.signal, scope = entry.scope
    entry.pending = true
    try {
      if (entry.leaseId && !viewLost(entry) && focusExisting(entry)) {
        remember(entry, command.operationId)
        return
      }
      const oldTab = present !== false ? entry.tabId : null
      const result = await rpc('editorBrowserLaunch', { sessionId: entry.sessionId }, signal)
      if (!isCurrent(entry) || signal.aborted || entry.scope !== scope || entry.command?.operationId !== command.operationId) return
      if (result.accountScope !== scope || typeof result.leaseId !== 'string' || !result.leaseId) throw new Error('浏览器页面的账号范围已变化。')
      let url
      try { url = new URL(result.url) } catch { throw new Error('编辑器页面地址无效。') }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('编辑器必须由可信本机 HTTP 服务提供。')
      ctx.sidebarRight.openTab('browser', { params: { url: url.href }, ...(oldTab ? { replaceTab: oldTab } : {}) })
      const tab = ctx.sidebarRight.active()
      if (!tab || tab.kind !== 'browser' || !tab.id) throw new Error('内置右侧浏览器尚未就绪，请启用应用的浏览器功能后重试。')
      entry.tabId = tab.id; entry.leaseId = result.leaseId; entry.openedAt = now(); remember(entry, command.operationId)
    } catch (error) {
      if (isCurrent(entry) && !signal.aborted && entry.command?.operationId === command.operationId) {
        remember(entry, command.operationId)
        onError(error)
        try { await rpc('editorFail', { sessionId: entry.sessionId, operationId: command.operationId, message: messageOf(error) }, signal) } catch {}
      }
    } finally {
      entry.pending = false
      if (signal.aborted || entry.scope !== scope || entry.command?.operationId !== command.operationId) void launch(entry)
    }
  }
  async function follow(entry, controller) {
    while (!controller.signal.aborted && isCurrent(entry)) {
      try {
        const value = await rpc('editorWatch', { sessionId: entry.sessionId, afterCursor: entry.cursor }, controller.signal)
        if (controller.signal.aborted || !isCurrent(entry)) return
        observeScope(value)
        if (value.cursor < entry.cursor) continue
        entry.scope = value.accountScope; entry.cursor = value.cursor; entry.command = value.command ?? null; entry.view = value.browserView ?? null
        void launch(entry)
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(entry)) return
        clear(); accountScope = undefined; onError(error)
        await wait(retryDelay, controller.signal)
      }
    }
  }
  function activate(force = false) {
    const next = ctx.sidebarRight.mounted.getSnapshot()
    if (!force && currentId === next) return
    watching?.abort()
    if (currentId !== undefined) { const old = entryFor(currentId); old.actions.abort(); old.actions = new AbortController() }
    currentId = next
    if (disposed || next === undefined) return
    watching = new AbortController()
    void follow(entryFor(next), watching)
  }
  return {
    start() {
      if (started || disposed) return
      started = true
      unsubscribe = ctx.sidebarRight.mounted.subscribe(() => activate())
      unsubscribeGeneration = ctx.connection.generation?.subscribe(() => { clear(); accountScope = undefined; activate(true) })
      activate()
    },
    dispose() { disposed = true; watching?.abort(); unsubscribe?.(); unsubscribeGeneration?.(); clear() },
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const launcher = createBuiltinBrowserLauncher(ctx)
    launcher.start()
    return () => launcher.dispose()
  }, 'dsh-ez-tree: built-in Browser launcher')
}
