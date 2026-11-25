import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dataDirectory } from '../desktop/paths.mjs'

const methods = new Set(['listPresets', 'getPresetOptions', 'getOptions', 'setOptions', 'exportFile'])
const MAX_MESSAGE = 128 * 1024 * 1024

function messages(socket, callback, onError) {
  let buffered = Buffer.alloc(0)
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk])
    if (buffered.length > MAX_MESSAGE) return onError(new Error('渲染器消息超过 128 MiB。'))
    while (true) {
      const index = buffered.indexOf(10)
      if (index < 0) return
      const line = buffered.subarray(0, index)
      buffered = buffered.subarray(index + 1)
      try { callback(JSON.parse(line.toString('utf8'))) }
      catch (error) { onError(error); return }
    }
  })
  socket.on('error', onError)
}

const send = (socket, value) => socket.write(JSON.stringify(value) + '\n')

export async function openRenderer({ executable, appEntry, account, onFailure }) {
  const token = randomBytes(32).toString('hex')
  const directory = await mkdtemp(join(tmpdir(), 'ez-tree-pipe-'))
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\ez-tree-${randomBytes(24).toString('hex')}` : join(directory, 'renderer.sock')
  const waiting = new Map()
  let socket
  let child
  let sequence = 0
  let closed = false
  let initialized = false
  let accept
  let rejectReady
  const ready = new Promise((resolve, reject) => { accept = resolve; rejectReady = reject })
  const fail = error => {
    rejectReady(error)
    for (const request of waiting.values()) { clearTimeout(request.timer); request.reject(error) }
    waiting.clear()
    if (!closed && initialized) onFailure?.(error)
  }
  const listener = net.createServer(connection => {
    if (socket) return connection.destroy()
    let authenticated = false
    const timeout = setTimeout(() => connection.destroy(), 3000)
    messages(connection, message => {
      if (!authenticated) {
        const received = typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0)
        const expected = Buffer.from(token)
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) return connection.destroy()
        authenticated = true
        clearTimeout(timeout)
        socket = connection
        accept()
        return
      }
      const request = waiting.get(message.id)
      if (!request) return fail(new Error('渲染器返回未知请求编号。'))
      waiting.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(String(message.error)))
      else request.resolve(message.result)
    }, error => { connection.destroy(); if (authenticated) fail(error) })
    connection.on('close', () => { clearTimeout(timeout); if (authenticated && !closed) fail(new Error('渲染器连接已关闭。')) })
  })
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(endpoint, resolve) })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [...(appEntry ? [appEntry] : []), '--render-pipe', endpoint, '--render-token', token,
    ...(account ? ['--account', account] : [])], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.once('error', fail)
  child.once('exit', (code, signal) => { if (!closed) fail(new Error(`渲染器进程已退出：${code ?? signal}`)) })
  const startup = setTimeout(() => fail(new Error('渲染器启动超过 90 秒。')), 90_000)
  const close = async () => {
    if (closed) return
    closed = true
    clearTimeout(startup)
    for (const request of waiting.values()) { clearTimeout(request.timer); request.reject(new Error('渲染器已关闭。')) }
    waiting.clear()
    socket?.destroy()
    listener.close()
    if (child.pid && child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => { child.kill(); resolve() }, 2000).unref())])
    }
    if (child.pid) await rm(join(dataDirectory({ account }), 'browser', `mcp-${child.pid}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(directory, { recursive: true, force: true })
  }
  try { await ready; initialized = true }
  catch (error) { await close(); throw error }
  finally { clearTimeout(startup) }
  return {
    close,
    call(method, value) {
      if (!methods.has(method)) return Promise.reject(new Error('未知渲染器操作。'))
      if (closed || socket.destroyed) return Promise.reject(new Error('渲染器已关闭。'))
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          const error = new Error('渲染器请求超过 90 秒。')
          reject(error)
          fail(error)
        }, 90_000)
        waiting.set(id, { resolve, reject, timer })
        send(socket, { id, method, value })
      })
    },
  }
}

export async function serveRenderer({ endpoint, token, editor, onClose }) {
  const socket = net.createConnection(endpoint)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  send(socket, { token })
  let queue = Promise.resolve()
  messages(socket, request => {
    queue = queue.then(async () => {
      try {
        if (!Number.isSafeInteger(request.id) || !methods.has(request.method)) throw new Error('渲染器请求无效。')
        const result = await editor.call(request.method, request.value)
        send(socket, { id: request.id, result })
      } catch (error) { send(socket, { id: request.id, error: error.message }) }
    })
  }, () => socket.destroy())
  socket.once('close', () => onClose?.())
  return socket
}
