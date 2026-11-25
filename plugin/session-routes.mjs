import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { packageRoot } from './runtime.mjs'

export const MAX_EDITOR_UPLOAD_BYTES = 128 * 1024 * 1024
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.frag': 'text/plain', '.vert': 'text/plain', '.glsl': 'text/plain' }

function failure(message, status = 400, code = 'invalidInput') { return Object.assign(new Error(message), { status, code }) }

export function sendSessionJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

export function admitOwner(ctx, request, response, peer) {
  const admission = peer === undefined ? ctx.connection.admit(request) : { peer }
  if (admission.rejection !== undefined) {
    sendSessionJson(response, admission.rejection, { ok: false, error: { code: 'unauthorized', message: '请重新连接当前桌面会话。', details: {} } })
    return
  }
  if (admission.peer?.principal?.kind !== 'owner') {
    sendSessionJson(response, 403, { ok: false, error: { code: 'forbidden', message: '仅当前所有者可以访问树木编辑器。', details: {} } })
    return
  }
  return admission.peer
}

function requestSignal(request, response, parentSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => { if (!response.writableEnded) controller.abort() }
  request.once('aborted', abort)
  response.once('close', close)
  return { signal: parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal,
    dispose() { request.removeListener('aborted', abort); response.removeListener('close', close) } }
}

function resultError(ctx, response, error) {
  const aborted = error.name === 'AbortError'
  if (!error.status && !aborted) ctx.logger?.warn?.(`EZ-Tree 编辑器请求失败：${error.message}`)
  sendSessionJson(response, error.status ?? (aborted ? 499 : error.code === 'identityChanged' ? 409 : error.code === 'authenticationRequired' ? 401 : 400),
    { ok: false, error: { code: typeof error.code === 'string' ? error.code : aborted ? 'cancelled' : 'editorFailed', message: aborted ? '操作已取消。' : error.message, details: {} } })
}

async function editorFile(directory, pathname) {
  if (pathname !== '/dsh-ez-tree/editor' && !pathname.startsWith('/dsh-ez-tree/editor/')) throw failure('找不到编辑器资源。', 404, 'notFound')
  let decoded
  try { decoded = decodeURIComponent(pathname.slice('/dsh-ez-tree/editor'.length)) } catch { throw failure('编辑器资源路径无效。', 400) }
  const member = decoded === '' || decoded === '/' ? 'index.html' : decoded.slice(1)
  const parts = member.split('/')
  if (parts.some(part => !part || part.startsWith('.') || /[\\:\x00-\x1f\x7f]/.test(part))) throw failure('编辑器资源路径无效。', 403)
  const base = await realpath(directory)
  const target = resolve(base, ...parts)
  const inside = relative(base, target)
  if (!inside || inside === '..' || inside.startsWith('..' + sep)) throw failure('编辑器资源路径越界。', 403)
  let parent = base
  for (const part of parts) {
    parent = join(parent, part)
    const stat = await lstat(parent)
    if (stat.isSymbolicLink()) throw failure('编辑器资源不能包含链接。', 403)
  }
  const stat = await lstat(target)
  if (!stat.isFile()) throw failure('找不到编辑器资源。', 404, 'notFound')
  return { target, stat }
}

/** 调用方先完成自身授权；此处只处理限定资源目录与响应，不制造 Peer。 */
export async function serveEditorResource(request, response, { editorDirectory = join(packageRoot, 'lib/editor'), pathname, check = () => {} } = {}) {
  if (!['GET', 'HEAD'].includes(request.method)) throw failure('编辑器资源只支持 GET/HEAD。', 405)
  let file
  try { file = await editorFile(editorDirectory, pathname ?? new URL(request.url, 'http://localhost').pathname) }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw failure('找不到编辑器资源。', 404, 'notFound'); throw error }
  await check()
  response.writeHead(200, { 'content-type': mimeTypes[extname(file.target).toLowerCase()] ?? 'application/octet-stream', 'content-length': file.stat.size,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' })
  if (request.method === 'HEAD') response.end()
  else await pipeline(createReadStream(file.target), response)
}

/** 调用方绑定账号/会话后才可使用；只接收当前挂起导出的字节，不能选择输出路径。 */
export async function acceptEditorUpload(request, { store, account, sessionId, operationId, signal, assertScope, assertSession,
  uploadLimit = MAX_EDITOR_UPLOAD_BYTES, logger } = {}) {
  let authorized = false
  try {
    if (request.method !== 'POST') throw failure('导出上传只支持 POST。', 405)
    if (String(request.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw failure('导出上传必须使用二进制数据。', 415)
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || /[\x00-\x1f]/.test(sessionId)
      || typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw failure('导出操作标识无效。')
    await assertSession(account, sessionId, signal)
    const snapshot = await store.read(account, sessionId)
    assertScope(account)
    if (!snapshot.project || snapshot.command?.kind !== 'export' || snapshot.command.operationId !== operationId) throw failure('导出操作已失效，请重新导出。', 409, 'operationExpired')
    authorized = true
    const declared = request.headers['content-length']
    if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > uploadLimit)) throw failure('导出文件超过 128 MiB 限制。', 413, 'tooLarge')
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      signal?.throwIfAborted()
      const buffer = Buffer.from(chunk)
      size += buffer.byteLength
      if (size > uploadLimit) throw failure('导出文件超过 128 MiB 限制。', 413, 'tooLarge')
      chunks.push(buffer)
    }
    signal?.throwIfAborted()
    await assertSession(account, sessionId, signal)
    assertScope(account)
    const artifact = await store.upload(account, sessionId, operationId, Buffer.concat(chunks, size))
    assertScope(account)
    return artifact
  } catch (error) {
    if (authorized) {
      try { await store.fail(account, sessionId, operationId, error.message) }
      catch (failure) { logger?.warn?.(`EZ-Tree 导出状态清理失败：${failure.message}`) }
    }
    throw error
  }
}

/** 返回公开 WebRoute 描述；exact export 与更长的 editor prefix 不会被通用 RPC prefix 吞掉。 */
export function createSessionRoutes(ctx, { store, scope, assertScope, assertSession, lifetimeSignal,
  editorDirectory = join(packageRoot, 'lib/editor'), uploadLimit = MAX_EDITOR_UPLOAD_BYTES }) {
  const staticRoute = { kind: 'prefix', path: '/dsh-ez-tree/editor', auth: 'required', async handler(request, response, admittedPeer) {
    const peer = admitOwner(ctx, request, response, admittedPeer)
    if (!peer) return
    try {
      const account = scope()
      await serveEditorResource(request, response, { editorDirectory, check: () => assertScope(account) })
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') resultError(ctx, response, failure('找不到编辑器资源。', 404, 'notFound'))
      else resultError(ctx, response, error)
    }
  } }
  const exportRoute = { kind: 'exact', path: '/dsh-ez-tree/export', auth: 'required', async handler(request, response, admittedPeer) {
    const peer = admitOwner(ctx, request, response, admittedPeer)
    if (!peer) return
    const operation = requestSignal(request, response, lifetimeSignal)
    try {
      const query = new URL(request.url, 'http://localhost').searchParams
      if ([...query.keys()].some(key => !['sessionId', 'operationId'].includes(key)) || query.getAll('sessionId').length !== 1 || query.getAll('operationId').length !== 1)
        throw failure('导出操作标识无效。')
      const artifact = await acceptEditorUpload(request, { store, account: scope(), sessionId: query.get('sessionId'), operationId: query.get('operationId'),
        signal: operation.signal, assertScope, assertSession, uploadLimit, logger: ctx.logger })
      sendSessionJson(response, 200, { ok: true, value: artifact })
    } catch (error) {
      resultError(ctx, response, error)
    } finally { operation.dispose() }
  } }
  return { staticRoute, exportRoute }
}

export function registerSessionRoutes(ctx, options) {
  const { staticRoute, exportRoute } = createSessionRoutes(ctx, options)
  const disposers = [ctx.webServer.register(staticRoute), ctx.webServer.register(exportRoute)]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
