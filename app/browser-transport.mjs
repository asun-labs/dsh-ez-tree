const allowed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key))
const projectKey = project => `${project.projectId}:${project.revision}:${project.optionsDigest}`

export function createBrowserTransport({ target = window, fetchImpl = fetch, ready: engineReady, handlers,
  onBusy = () => {}, report = () => {}, retryDelay = 500 }) {
  const lifetime = new AbortController()
  const base = new URL('./api/', target.location.href)
  const fragment = new URLSearchParams(target.location.hash.slice(1))
  const bootstrap = fragment.get('bootstrap')
  if (fragment.has('bootstrap')) target.history.replaceState(null, '', target.location.pathname + target.location.search)
  let closed = false, fatal, pendingIntent = false, exporting = false, applying = false, serverExport = false
  let leaseReady = false, released = false
  let cursor = 0, committed = null, rendered = null, lastMetrics = null
  let renderQueue = Promise.resolve()
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  const handled = new Set()
  const busy = () => onBusy(pendingIntent || applying)
  const current = () => { if (closed) throw fatal ?? new Error('浏览器编辑器连接已关闭，请重新从技能打开。') }
  function release() {
    if (!leaseReady || released) return
    released = true
    // 页面退出时仅软断开；保留 Cookie，让正常刷新可以恢复同一项目。
    void fetchImpl(new URL('release', base).href, { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
  }
  function dispose(error) {
    if (closed) return
    release()
    fatal = error instanceof Error ? error : new Error('浏览器编辑器已关闭。')
    closed = true
    lifetime.abort(fatal)
    rejectReady(fatal)
    handlers.dispose?.()
    target.removeEventListener?.('pagehide', release)
  }
  const authorizationFailure = error => [401, 403, 410].includes(error.status)
    || ['identityChanged', 'viewExpired', 'invalidLease', 'sessionUnavailable', 'disposed'].includes(error.code)
  async function request(action, payload = {}, binary) {
    current()
    const url = new URL(action, base)
    if (binary) url.searchParams.set('operationId', binary.operationId)
    const response = await fetchImpl(url.href, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' },
      body: binary ? binary.buffer : JSON.stringify(payload), signal: lifetime.signal })
    const body = await response.json()
    if (!response.ok || body?.ok !== true) {
      const error = Object.assign(new Error(body?.error?.message || `编辑器请求失败（HTTP ${response.status}）。`),
        { status: response.status, code: body?.error?.code })
      if (authorizationFailure(error)) { dispose(error); report(error.message, true) }
      throw error
    }
    return body.value
  }
  const enqueue = operation => {
    const result = renderQueue.then(async () => {
      current()
      await engineReady()
      applying = true; busy()
      try { return await operation() }
      finally { applying = false; busy() }
    })
    renderQueue = result.catch(() => {})
    return result
  }
  async function synchronize(project) {
    if (!project) return
    if (rendered !== projectKey(project)) {
      lastMetrics = await handlers.applyProject({ ...project, force: true })
      rendered = projectKey(project)
    }
    resolveReady({ project, metrics: lastMetrics })
  }
  async function consume(value) {
    if (!value || !Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error('编辑器订阅响应无效。')
    if (value.cursor < cursor) return
    cursor = value.cursor
    committed = value.project ?? null
    const command = value.command
    if (!command && !committed && value.error) {
      const reason = new Error(typeof value.error === 'string' ? value.error : '首次树木渲染未提交，请重新从技能打开。')
      dispose(reason); report(reason.message, true); return
    }
    if (!command) return enqueue(() => synchronize(committed))
    if (handled.has(command.operationId)) return
    return enqueue(async () => {
      try {
        if (command.kind === 'apply') {
          const metrics = await handlers.applyProject(command.project)
          if (metrics.revision !== command.project.revision || metrics.optionsDigest !== command.project.optionsDigest) throw new Error('实际树木与会话项目不一致。')
          rendered = projectKey(command.project)
          lastMetrics = metrics
          await request('ack', { operationId: command.operationId, revision: metrics.revision,
            optionsDigest: metrics.optionsDigest, metrics: { vertexCount: metrics.vertexCount, triangleCount: metrics.triangleCount } })
        } else if (command.kind === 'export') {
          if (rendered !== projectKey(command.project) || pendingIntent && !exporting) {
            lastMetrics = await handlers.applyProject({ ...command.project, force: true })
            rendered = projectKey(command.project)
          }
          // Host 已按队列选定已提交修订；先恢复该快照，再允许导出，不能读取 UI 草稿。
          serverExport = true
          const result = await handlers.exportFile({ format: command.format, revision: command.project.revision })
          if (!(result.buffer instanceof ArrayBuffer) || result.buffer.byteLength > 128 * 1024 * 1024
            || result.revision !== command.project.revision || result.optionsDigest !== command.project.optionsDigest) throw new Error('导出文件与当前项目不一致。')
          await request('upload', {}, { operationId: command.operationId, buffer: result.buffer })
        } else throw new Error('未知会话编辑命令。')
        handled.add(command.operationId)
        if (handled.size > 32) handled.delete(handled.values().next().value)
      } catch (error) {
        rendered = null
        report(error.message, true)
        if (!closed) await request('fail', { operationId: command.operationId, message: error.message.slice(0, 1000) })
      } finally { serverExport = false }
    })
  }
  async function follow() {
    let failures = 0
    while (!closed) {
      try { await consume(await request('watch', { afterCursor: cursor })); failures = 0 }
      catch (error) {
        if (closed) return
        if (++failures >= 3) {
          const reason = new Error('编辑器连接已中断，请重新从技能打开以恢复项目。', { cause: error })
          dispose(reason); report(reason.message, true); return
        }
        report(error.message, true)
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, retryDelay)
          lifetime.signal.addEventListener('abort', done, { once: true })
        })
      }
    }
  }
  async function begin() {
    try {
      if (bootstrap !== null) { await request('redeem', { token: bootstrap }); leaseReady = true }
      const value = await request('read')
      leaseReady = true
      await consume(value)
      void follow()
    } catch (error) { dispose(error); report(error.message, true) }
  }
  target.addEventListener?.('pagehide', release)
  // 不等待编辑/导出 HTTP 响应进入渲染队列；它们需要 watch 消费命令并 ACK 后才能完成。
  async function requestIntent(intent) {
    current()
    if (!allowed(intent, ['expectedRevision', 'preset', 'options', 'export'])) throw new Error('编辑请求包含不支持的字段。')
    if (pendingIntent || applying) throw new Error('请等待当前操作完成。')
    pendingIntent = true; exporting = Boolean(intent.export); busy()
    try {
      if (intent.export) {
        if (!allowed(intent.export, ['format', 'name'])) throw new Error('导出请求包含不支持的字段。')
        const artifact = await request('export', intent.export)
        report(`已保存到：${artifact.path}`)
        return artifact
      }
      const result = await request('edit', { expectedRevision: intent.expectedRevision,
        ...(intent.preset !== undefined ? { preset: intent.preset } : {}), ...(intent.options !== undefined ? { options: intent.options } : {}) })
      const project = result.project ?? result
      committed = project
      await enqueue(() => synchronize(project))
      return project
    } catch (error) {
      if (!closed) {
        const value = await request('read')
        committed = value.project ?? null
        if (committed) await enqueue(() => synchronize(committed))
      }
      throw error
    } finally { pendingIntent = false; exporting = false; busy() }
  }
  void begin()
  return {
    ready, dispose,
    get pendingMutation() { return pendingIntent && !exporting && !serverExport },
    requestIntent,
    async readProject() { const value = await request('read'); return value.project ?? null },
    async exportFile(value = {}) {
      if (!allowed(value, ['format', 'name'])) throw new Error('导出只接受格式和文件名。')
      await ready
      return requestIntent({ export: value })
    },
  }
}
