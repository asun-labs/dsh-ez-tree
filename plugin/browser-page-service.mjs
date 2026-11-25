import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { serveEditorResource, acceptEditorUpload, sendSessionJson } from './session-routes.mjs'

const cookieName = 'ez-tree-view'
const digest = value => createHash('sha256').update(value).digest()
const scopeKey = value => JSON.stringify([value.mode, value.accountId, value.epoch])
const sessionKey = (scope, sessionId) => JSON.stringify([scopeKey(scope), sessionId])
const denied = (message, status = 401, code = 'viewUnauthorized') => Object.assign(new Error(message), { status, code })
const methods = { read: 'editorRead', watch: 'editorWatch', edit: 'editorEdit', export: 'editorExport', ack: 'editorAck', fail: 'editorFail' }
const fields = { read: [], watch: ['afterCursor'], edit: ['expectedRevision', 'preset', 'options'], export: ['format', 'name'],
  ack: ['operationId', 'revision', 'optionsDigest', 'metrics'], fail: ['operationId', 'message'], redeem: ['token'], release: [] }

function validSecret(value, expected) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.isBuffer(expected) && timingSafeEqual(digest(value), expected)
}
function cookie(headers) {
  if (typeof headers.cookie !== 'string') return
  const values = headers.cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(cookieName + '='))
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : undefined
}
async function jsonBody(request) {
  if (String(request.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/json') throw denied('页面 API 必须使用 JSON。', 415, 'invalidInput')
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.byteLength
    if (length > 16384) throw denied('页面请求超过大小限制。', 413, 'tooLarge')
    chunks.push(buffer)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks, length).toString('utf8')) } catch { throw denied('页面请求不是有效 JSON。', 400, 'invalidInput') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw denied('页面请求格式无效。', 400, 'invalidInput')
  return value
}

/** 内置浏览器使用独立来源；这里只授予单个账号、会话与工作目录的编辑能力。 */
export class BrowserPageService {
  constructor({ ctx, store, scope, assertScope, checkView, handlers, editorDirectory, now = Date.now,
    ticketTtlMs = 60000, idleTtlMs = 30 * 60 * 1000, absoluteTtlMs = 8 * 60 * 60 * 1000, presenceGraceMs = 5000 } = {}) {
    Object.assign(this, { ctx, store, scope, assertScope, checkView, handlers, editorDirectory, now, ticketTtlMs, idleTtlMs, absoluteTtlMs, presenceGraceMs })
    this.leases = new Map()
    this.sessions = new Map()
    this.lifetime = new AbortController()
    this.disposed = false
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(idleTtlMs, 30000))
    this.sweepTimer.unref()
  }
  expiresAt(lease) { return Math.min(lease.createdAt + this.absoluteTtlMs, lease.lastActivity + this.idleTtlMs) }
  expired(lease) { return this.now() >= this.expiresAt(lease) || !lease.cookieDigest && this.now() >= lease.ticketExpiresAt }
  revoke(lease, reason = '编辑器页面访问已结束。') {
    this.leases.delete(lease.id)
    if (this.sessions.get(lease.key) === lease.id) this.sessions.delete(lease.key)
    lease.controller.abort(denied(reason))
  }
  revokeAll(reason) { for (const lease of [...this.leases.values()]) this.revoke(lease, reason) }
  sweep() {
    for (const lease of [...this.leases.values()]) {
      try { this.assertScope(lease.scope); if (this.expired(lease)) this.revoke(lease, '编辑器页面已过期，请重新调用技能打开。') }
      catch { this.revoke(lease, '账号已变化，请重新调用技能打开编辑器。') }
    }
  }
  state(scope, sessionId) {
    const lease = this.leases.get(this.sessions.get(sessionKey(scope, sessionId)))
    if (!lease) return null
    try { this.assertScope(lease.scope) } catch { this.revoke(lease); return null }
    if (this.expired(lease)) { this.revoke(lease); return null }
    return { leaseId: lease.id, connected: !lease.detached && lease.activeWatches > 0 || this.now() - lease.lastSeen <= this.presenceGraceMs,
      lastSeen: lease.lastSeen, expiresAt: this.expiresAt(lease) }
  }
  async listen() {
    if (this.disposed) throw denied('编辑器页面服务已关闭。', 503, 'disposed')
    if (!this.listening) {
      this.listening = new Promise((resolveListen, rejectListen) => {
        const server = createServer({ maxHeaderSize: 16384 }, (request, response) => { void this.respond(request, response) })
        this.server = server
        server.requestTimeout = 60000
        server.headersTimeout = 10000
        server.on('error', rejectListen)
        server.listen(0, '127.0.0.1', () => {
          if (this.disposed) { server.close(); rejectListen(denied('编辑器页面服务已关闭。', 503, 'disposed')); return }
          this.origin = `http://127.0.0.1:${server.address().port}`
          resolveListen(server)
        })
      })
    }
    await this.listening
  }
  async launch(scope, sessionId, { workspace, signal } = {}) {
    signal?.throwIfAborted()
    this.assertScope(scope)
    await this.checkView(scope, sessionId, workspace, signal)
    await this.listen()
    signal?.throwIfAborted()
    this.assertScope(scope)
    this.sweep()
    const key = sessionKey(scope, sessionId), previous = this.leases.get(this.sessions.get(key))
    if (previous) this.revoke(previous, '编辑器已在新页面打开。')
    if (this.leases.size >= 64) throw denied('打开的编辑器视图过多，请关闭空闲页面后重试。', 409, 'tooManyViews')
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), createdAt = this.now()
    const lease = { id, key, scope: Object.freeze({ ...scope }), sessionId, workspace, createdAt, lastActivity: createdAt, lastSeen: createdAt,
      ticketExpiresAt: createdAt + this.ticketTtlMs, ticketDigest: digest(token), cookieDigest: null, activeWatches: 0, controller: new AbortController() }
    this.leases.set(id, lease)
    this.sessions.set(key, id)
    return { url: `${this.origin}/view/${id}/index.html#bootstrap=${token}`, leaseId: id }
  }
  hostMatches(request) {
    const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0).filter(value => value.toLowerCase() === 'host')
    return hosts.length === 1 && request.headers.host === new URL(this.origin).host
  }
  async check(lease, signal) {
    if (this.disposed || !this.leases.has(lease.id) || this.expired(lease)) throw denied('编辑器页面已过期，请重新调用技能打开。')
    try {
      this.assertScope(lease.scope)
      await this.checkView(lease.scope, lease.sessionId, lease.workspace, signal)
      signal.throwIfAborted()
      this.assertScope(lease.scope)
    } catch (error) {
      if (['identityChanged', 'authenticationRequired', 'workspaceChanged', 'sessionUnavailable'].includes(error.code)) this.revoke(lease, '账号、会话或工作目录已变化，请重新调用技能打开。')
      throw error
    }
  }
  async respond(request, response) {
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    let lease, activeWatch = false
    const requestLife = new AbortController()
    const abort = () => requestLife.abort()
    const close = () => {
      if (!response.writableEnded) { if (lease) lease.lastSeen = this.now(); requestLife.abort() }
    }
    request.once('aborted', abort)
    response.once('close', close)
    try {
      if (!this.origin || !this.hostMatches(request)) throw denied('编辑器请求来源无效。', 403, 'invalidHost')
      const url = new URL(request.url, this.origin)
      if (url.origin !== this.origin) throw denied('编辑器请求来源无效。', 403, 'invalidHost')
      const match = url.pathname.match(/^\/view\/([A-Za-z0-9_-]{1,128})\/(.+)$/)
      if (!match) throw denied('找不到编辑器页面。', 404, 'notFound')
      lease = this.leases.get(match[1])
      if (!lease) throw denied('编辑器页面访问已结束，请重新调用技能打开。')
      const signal = AbortSignal.any([this.lifetime.signal, lease.controller.signal, requestLife.signal])
      await this.check(lease, signal)
      const member = match[2]
      if (!member.startsWith('api/')) {
        if (url.search || !['GET', 'HEAD'].includes(request.method)) throw denied('找不到编辑器资源。', 404, 'notFound')
        await serveEditorResource(request, response, { editorDirectory: this.editorDirectory, pathname: '/dsh-ez-tree/editor/' + member,
          check: () => this.check(lease, signal) })
        return
      }
      if (request.method !== 'POST') throw denied('页面 API 只支持 POST。', 405, 'invalidInput')
      if (request.headers.origin !== this.origin) throw denied('编辑器请求来源无效。', 403, 'invalidOrigin')
      const method = member.slice(4)
      if (!Object.hasOwn(methods, method) && !['redeem', 'upload', 'release'].includes(method)) throw denied('未知编辑器接口。', 404, 'notFound')
      if (method !== 'upload' && url.search) throw denied('页面 API 参数无效。', 400, 'invalidInput')
      if (method !== 'redeem' && !validSecret(cookie(request.headers), lease.cookieDigest)) throw denied('编辑器访问凭证已失效，请重新调用技能打开。')
      lease.lastActivity = this.now()
      lease.lastSeen = this.now()
      lease.detached = false
      if (method === 'upload') {
        if ([...url.searchParams.keys()].some(key => key !== 'operationId') || url.searchParams.getAll('operationId').length !== 1) throw denied('导出操作标识无效。', 400, 'invalidInput')
        const artifact = await acceptEditorUpload(request, { store: this.store, account: lease.scope, sessionId: lease.sessionId,
          operationId: url.searchParams.get('operationId'), signal, assertScope: this.assertScope,
          assertSession: () => this.checkView(lease.scope, lease.sessionId, lease.workspace, signal), logger: this.ctx.logger })
        await this.check(lease, signal)
        sendSessionJson(response, 200, { ok: true, value: artifact })
        return
      }
      const payload = await jsonBody(request)
      if (Object.keys(payload).some(key => !fields[method].includes(key))) throw denied('页面 API 不接受账号、会话或工作目录参数。', 400, 'invalidInput')
      signal.throwIfAborted()
      await this.check(lease, signal)
      if (method === 'redeem') {
        if (!validSecret(payload.token, lease.ticketDigest) || this.now() >= lease.ticketExpiresAt) throw denied('编辑器打开凭证无效或已使用，请重新调用技能打开。')
        // 同步消耗一次性 ticket，后续异步操作不能让并发兑换复用它。
        lease.ticketDigest = null
        const secret = randomBytes(32).toString('base64url')
        lease.cookieDigest = digest(secret)
        response.setHeader('set-cookie', `${cookieName}=${secret}; Path=/view/${lease.id}/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil((lease.createdAt + this.absoluteTtlMs - this.now()) / 1000)}`)
        sendSessionJson(response, 200, { ok: true, value: { leaseId: lease.id } })
        return
      }
      if (method === 'release') {
        lease.detached = true
        const snapshot = await this.store.read(lease.scope, lease.sessionId)
        this.assertScope(lease.scope)
        if (lease.observedOperationId && snapshot.command?.operationId === lease.observedOperationId)
          await this.store.fail(lease.scope, lease.sessionId, lease.observedOperationId, '编辑器页面已离开，请在当前会话重新调用技能后重试。')
        lease.observedOperationId = undefined
        sendSessionJson(response, 200, { ok: true, value: { released: true } })
        return
      }
      if (method === 'watch') { lease.activeWatches++; activeWatch = true }
      const value = await this.handlers[methods[method]]({ ...payload, sessionId: lease.sessionId }, signal)
      await this.check(lease, signal)
      if (method === 'read' || method === 'watch') lease.observedOperationId = value.command?.operationId
      lease.lastSeen = this.now()
      sendSessionJson(response, 200, { ok: true, value })
    } catch (error) {
      const cancelled = error.name === 'AbortError'
      const status = error.status ?? (cancelled ? 499 : ['identityChanged', 'workspaceChanged'].includes(error.code) ? 409 : error.code === 'authenticationRequired' ? 401 : 400)
      sendSessionJson(response, status, { ok: false, error: { code: typeof error.code === 'string' ? error.code : cancelled ? 'cancelled' : 'browserPageFailed',
        message: cancelled ? '页面请求已取消。' : error.message, details: {} } })
    } finally {
      if (activeWatch) lease.activeWatches--
      request.removeListener('aborted', abort)
      response.removeListener('close', close)
    }
  }
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.sweepTimer)
    this.lifetime.abort()
    this.revokeAll('编辑器页面服务已关闭。')
    if (!this.server) return
    try { await this.listening } catch { return }
    if (!this.server.listening) return
    const stopped = new Promise((resolveClose, rejectClose) => this.server.close(error => error ? rejectClose(error) : resolveClose()))
    this.server.closeAllConnections()
    await stopped
  }
}
