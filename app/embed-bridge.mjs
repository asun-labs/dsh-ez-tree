const METHODS = new Set(['applyProject', 'exportFile', 'setVisible', 'dispose'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createEmbeddedBridge({ target = window, ready, handlers, onBusy = () => {}, report = () => {} }) {
  let port
  let disposed = false
  let pending
  let sequence = 0
  let applying = false
  let queue = Promise.resolve()
  const busy = () => onBusy(Boolean(pending || applying))
  const enqueue = operation => {
    const result = queue.then(() => {
      if (disposed) throw new Error('编辑器已关闭。')
      return operation()
    })
    queue = result.catch(() => {})
    return result
  }
  const send = (message, transfer = []) => { if (!disposed && port) port.postMessage(message, transfer) }
  const finishIntent = async message => {
    if (!pending || message.id !== pending.id) return
    const intent = pending
    try {
      if (message.project) await handlers.applyProject(message.project)
      if (!message.ok) {
        await handlers.restore?.()
        throw new Error(typeof message.error === 'string' ? message.error : '会话未接受此次修改。')
      }
      const artifact = message.artifact ?? message.result?.artifact ?? message.result
      if (artifact?.path) report(`已保存到：${artifact.path}`)
      intent.resolve(message.project ?? artifact)
    } catch (error) { intent.reject(error) }
    finally { clearTimeout(intent.timer); if (pending === intent) pending = null; busy() }
  }
  const receive = event => {
    const message = event.data
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    if (message.type === 'intent-result') {
      void enqueue(() => finishIntent(message)).catch(error => report(error.message, true))
      return
    }
    if ((typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) || !METHODS.has(message.method)) {
      if (message.id !== undefined) send({ id: message.id, ok: false, error: '未知编辑器命令。' })
      return
    }
    void enqueue(async () => {
      try {
        if (message.method !== 'dispose') await ready()
        if (message.method === 'exportFile' && pending && !pending.exporting) throw new Error('参数尚未提交，请等待修改完成后导出。')
        applying = true; busy()
        const result = await handlers[message.method](message.params)
        const transfer = message.method === 'exportFile' && result?.buffer instanceof ArrayBuffer ? [result.buffer] : []
        send({ id: message.id, ok: true, result }, transfer)
        if (message.method === 'dispose') dispose(false)
      } catch (error) { send({ id: message.id, ok: false, error: error.message }) }
      finally { applying = false; busy() }
    }).catch(error => report(error.message, true))
  }
  const connect = event => {
    const message = event.data
    if (disposed || port || target.parent === target || event.source !== target.parent
      || !target.location.origin || target.location.origin === 'null' || event.origin !== target.location.origin
      || message?.type !== 'dsh-ez-tree/connect' || message.version !== 1 || !UUID.test(message.channelId)
      || event.ports?.length !== 1) return
    port = event.ports[0]
    port.onmessage = receive
    port.start?.()
    void Promise.resolve().then(ready).then(() => {
      send({ type: 'ready', channelId: message.channelId, version: 1 })
    }).catch(error => send({ type: 'error', channelId: message.channelId, version: 1, error: error.message }))
  }
  function dispose(release = true) {
    if (disposed) return
    if (release) handlers.dispose?.()
    disposed = true
    target.removeEventListener('message', connect)
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('编辑器已关闭。')); pending = null }
    if (port) { port.onmessage = null; port.close(); port = null }
  }
  target.addEventListener('message', connect)
  return {
    dispose,
    get pendingMutation() { return Boolean(pending && !pending.exporting) },
    requestIntent(intent) {
      if (disposed || !port) return Promise.reject(new Error('编辑器尚未连接到当前会话。'))
      if (pending || applying) return Promise.reject(new Error('请等待当前操作完成。'))
      const id = `intent-${++sequence}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending?.id !== id) return
          pending = null
          busy()
          void handlers.restore?.()
          reject(new Error('会话响应超时，请重试。'))
        }, 90_000)
        pending = { id, resolve, reject, timer, exporting: Boolean(intent.export) }
        busy()
        send({ type: 'intent', id, intent })
      })
    },
  }
}
