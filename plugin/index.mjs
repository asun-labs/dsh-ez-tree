import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeManager, packageRoot } from './runtime.mjs'

export const name = 'dsh-ez-tree'
export const usage = '完整 EZ-Tree 桌面编辑器、树木生成 MCP 和内置技能。'
export const inject = ['connection', 'webServer']

const actions = new Set(['status', 'install', 'open', 'close', 'uninstall', 'prepareMcp', 'installSkill'])
const accountScope = snapshot => createHash('sha256').update(`${snapshot.mode}:${snapshot.accountId}:${snapshot.epoch}`).digest('hex').slice(0, 16)

class PluginError extends Error {
  constructor(message, code = 'operationFailed') { super(message); this.code = code }
}

/** 原生 DSH 按本机 owner 隔离；Seal 已加载身份服务时必须使用真实登录账号。 */
export function createHost(ctx, { Manager = RuntimeManager, loadSkill = () => readFile(join(packageRoot, 'skills/ez-tree/SKILL.md'), 'utf8') } = {}) {
  const entries = new Map()
  const lifetime = new AbortController()
  let disposed = false
  let unsubscribeIdentity
  const service = key => ctx.get?.(key)
  const identity = () => service('sealHarnessIdentity')
  function account() {
    const source = identity()
    if (!source) return { accountId: 'local-owner', epoch: 0, mode: 'local' }
    const current = source.getSession()
    if (!current?.accountId) throw new PluginError('请先登录 Seal 账号，再安装或打开 EZ-Tree。', 'authenticationRequired')
    return { accountId: current.accountId, epoch: current.epoch ?? 0, mode: 'seal' }
  }
  function assertAccount(snapshot) {
    lifetime.signal.throwIfAborted()
    const current = account()
    if (current.accountId !== snapshot.accountId || current.epoch !== snapshot.epoch || current.mode !== snapshot.mode)
      throw new PluginError('账号已变化，操作已取消，请刷新后重试。', 'identityChanged')
  }
  function entryFor(snapshot) {
    const key = `${snapshot.mode}:${snapshot.accountId}:${snapshot.epoch}`
    let entry = entries.get(key)
    if (!entry) {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, lifetime.signal])
      const manager = new Manager({ accountId: snapshot.accountId, signal, onLog: message => ctx.logger?.info?.(message) })
      entry = { snapshot, manager, controller, signal, busy: null, error: null }
      entries.set(key, entry)
    }
    return entry
  }
  async function invalidateAccounts() {
    let current
    try { current = account() } catch { current = null }
    const pending = []
    for (const [key, entry] of entries) {
      if (current && entry.snapshot.accountId === current.accountId && entry.snapshot.epoch === current.epoch && entry.snapshot.mode === current.mode) continue
      entry.controller.abort()
      entries.delete(key)
      pending.push(entry.manager.stop())
    }
    const results = await Promise.allSettled(pending)
    for (const result of results) if (result.status === 'rejected') ctx.logger?.warn?.(`EZ-Tree 账号切换清理失败：${result.reason.message}`)
  }
  function watchIdentity() {
    unsubscribeIdentity?.()
    unsubscribeIdentity = identity()?.subscribe?.(() => { void invalidateAccounts() })
    void invalidateAccounts()
    return () => { unsubscribeIdentity?.(); unsubscribeIdentity = undefined; void invalidateAccounts() }
  }
  async function status(snapshot, entry) {
    const runtime = await entry.manager.status()
    assertAccount(snapshot)
    return { ...runtime, busy: entry.busy, error: entry.error ?? runtime.error ?? null, identityMode: snapshot.mode, accountScope: accountScope(snapshot),
      connectorsAvailable: !!service('sealHarnessConnectors'), skillsAvailable: !!service('sealHarnessSkills') }
  }
  async function prepareMcp(snapshot, entry) {
    const descriptor = await entry.manager.descriptor()
    assertAccount(snapshot)
    const config = { command: descriptor.command, args: descriptor.args, cwd: descriptor.cwd, ...(descriptor.env ? { env: descriptor.env } : {}) }
    const connectors = service('sealHarnessConnectors')
    if (!connectors) return { config, registered: false, message: '将此配置添加到 DSH 的 MCP 连接器后，在需要的会话中启用。' }
    const id = `ez-tree-${createHash('sha256').update(snapshot.accountId).digest('hex').slice(0, 12)}`
    let listing = await connectors.call('list', {}, entry.signal)
    assertAccount(snapshot)
    let item = listing.items.find(value => value.id === id)
    if (!item) {
      const { env: _environment, ...draft } = config
      listing = await connectors.call('createDraft', { id, name: 'EZ-Tree', summary: '使用完整 EZ-Tree 引擎生成树木并导出 GLB、PNG 和参数 JSON。',
        category: 'office', transport: 'stdio', ...draft }, entry.signal)
      assertAccount(snapshot)
      item = listing.items.find(value => value.id === id)
    }
    const fingerprint = JSON.stringify(config)
    // 连接器的公开 DTO 只暴露 env 名称；首次准备或配置变化时重新写入固定启动环境。
    if (item && (item.command !== config.command || JSON.stringify(item.args) !== JSON.stringify(config.args) || item.cwd !== config.cwd
      || config.env && (entry.connectorConfig !== fingerprint || !Object.keys(config.env).every(key => item.env?.includes(key))))) {
      const { env, ...stdio } = config
      listing = await connectors.call('save', { id, revision: item.revision, name: item.name, summary: item.summary,
        category: item.category, transport: 'stdio', ...stdio, ...(env ? { envValues: env } : {}), enabled: false }, entry.signal)
      assertAccount(snapshot)
      item = listing.items.find(value => value.id === id)
    }
    if (!item) throw new PluginError('连接器保存后没有返回有效记录，请刷新重试。')
    if (item.installed === false) {
      listing = await connectors.call('installPersonal', { id, revision: item.revision }, entry.signal)
      assertAccount(snapshot)
      item = listing.items.find(value => value.id === id)
    }
    entry.connectorConfig = fingerprint
    return { config, registered: true, connectorId: id, enabled: item?.enabled === true,
      message: item?.enabled ? 'MCP 配置已存在，保留当前启用状态。' : 'MCP 已安装，默认停用。请在连接器页配置并启用，再选择会话权限。' }
  }
  async function installSkill(snapshot, entry) {
    const skills = service('sealHarnessSkills')
    if (!skills) return { installed: false, path: join(packageRoot, 'skills/ez-tree'), message: '内置技能随插件交付。请在当前 DSH 的技能管理中导入此目录。' }
    const content = await loadSkill()
    assertAccount(snapshot)
    const listing = await skills.call('list', {}, entry.signal)
    assertAccount(snapshot)
    const existing = listing.skills.find(value => value.name === 'ez-tree')
    if (existing) return { installed: existing.installed !== false, enabled: existing.enabled, skillId: existing.id, message: '当前账号已有 EZ-Tree 技能，保留现有副本和启用状态。' }
    const result = await skills.call('create', { content, enable: false, expectedRevision: listing.revision }, entry.signal)
    assertAccount(snapshot)
    return { installed: true, enabled: false, skillId: result.skills.find(value => value.name === 'ez-tree')?.id, message: '技能已安装到当前账号，默认停用。请在技能页按需启用。' }
  }
  async function assertMcpDisabled(snapshot, entry) {
    const connectors = service('sealHarnessConnectors')
    if (!connectors) return
    const listing = await connectors.call('list', {}, entry.signal)
    assertAccount(snapshot)
    const id = `ez-tree-${createHash('sha256').update(snapshot.accountId).digest('hex').slice(0, 12)}`
    if (listing.items.some(item => item.id === id && item.enabled))
      throw new PluginError('EZ-Tree 的 MCP 连接器仍已启用。请先前往连接器页面停用 EZ-Tree，再卸载应用；项目和导出文件会保留。', 'connectorEnabled')
  }
  async function handle(action, payload = {}, requestSignal, peer) {
    if (peer?.principal?.kind !== 'owner') return { ok: false, error: { code: 'forbidden', message: '仅本机所有者可以管理 EZ-Tree。', details: {} } }
    try {
      if (disposed) throw new PluginError('EZ-Tree 插件已卸载，请重新加载。', 'disposed')
      if (!actions.has(action) || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length)
        throw new PluginError('EZ-Tree 请求格式无效。', 'invalidInput')
      requestSignal?.throwIfAborted()
      const snapshot = account()
      const entry = entryFor(snapshot)
      if (action === 'status') return { ok: true, value: await status(snapshot, entry) }
      if (entry.busy) throw new PluginError('EZ-Tree 正在处理其他操作，请稍候。', 'busy')
      entry.busy = action
      entry.error = null
      try {
        let value
        if (action === 'prepareMcp') value = await prepareMcp(snapshot, entry)
        else if (action === 'installSkill') value = await installSkill(snapshot, entry)
        else {
          if (action === 'uninstall') await assertMcpDisabled(snapshot, entry)
          const method = { install: 'install', open: 'launch', close: 'stop', uninstall: 'uninstall' }[action]
          await entry.manager[method]()
          value = await status(snapshot, entry)
        }
        assertAccount(snapshot)
        return { ok: true, value: { ...value, accountScope: accountScope(snapshot) } }
      } catch (error) { entry.error = error.message; throw error }
      finally { entry.busy = null }
    } catch (error) {
      const aborted = error.name === 'AbortError'
      if (!aborted && !(error instanceof PluginError)) ctx.logger?.warn?.(`EZ-Tree 操作失败：${error.message}`)
      return { ok: false, error: { code: aborted ? 'cancelled' : error.code ?? 'operationFailed',
        message: aborted ? '操作已取消，请刷新状态后重试。' : error.message, details: {} } }
    }
  }
  return { handle, watchIdentity, async dispose() {
    disposed = true
    lifetime.abort()
    unsubscribeIdentity?.()
    const stopped = await Promise.allSettled([...entries.values()].map(entry => entry.manager.stop()))
    entries.clear()
    for (const result of stopped) if (result.status === 'rejected') ctx.logger?.warn?.(`EZ-Tree 退出清理失败：${result.reason.message}`)
  } }
}

export function apply(ctx) {
  const host = createHost(ctx)
  // 原生 0.2.2-rc.3 的自定义 RPC 通道路由丢失 webServer 注入作用域；保留相同协议，使用公开路由与准入接口。
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-ez-tree', async handler(request, response) {
    const admission = ctx.connection.admit(request)
    if (admission.rejection !== undefined) { response.writeHead(admission.rejection); response.end(); return }
    const action = new URL(request.url, 'http://localhost').pathname.slice('/dsh-ez-tree/'.length)
    if (request.method !== 'POST' || !actions.has(action)) { response.writeHead(404); response.end(); return }
    if (String(request.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/json') { response.writeHead(415); response.end(); return }
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 16384) { response.writeHead(413); response.end(); return }
        chunks.push(Buffer.from(chunk))
      }
      let message
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { response.writeHead(400); response.end(); return }
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'client-request'
        || typeof message.rpcId !== 'string' || !message.rpcId || message.rpcId.length > 256 || message.method !== action
        || Object.keys(message).some(key => !['type', 'rpcId', 'method', 'payload'].includes(key))) { response.writeHead(400); response.end(); return }
      const result = await host.handle(action, message.payload, controller.signal, admission.peer)
      if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result })) }
    } finally { request.removeListener('aborted', abort) }
  } }), 'dsh-ez-tree: authenticated RPC route')
  ctx.inject?.(['sealHarnessIdentity'], inner => inner.effect(host.watchIdentity, 'dsh-ez-tree: identity'))
  ctx.effect(() => () => host.dispose(), 'dsh-ez-tree: lifecycle')
}
