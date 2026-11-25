import { BrowserWindow, net, protocol } from 'electron'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

protocol.registerSchemesAsPrivileged([{ scheme: 'ez-tree', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }])

export function registerEditorProtocol(editorPath) {
  const root = dirname(resolve(editorPath))
  protocol.handle('ez-tree', request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
    let pathname
    try { pathname = decodeURIComponent(url.pathname) }
    catch { return new Response('Invalid path', { status: 400 }) }
    if (pathname.includes('\\') || pathname.includes('\0')) return new Response('Invalid path', { status: 400 })
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).href, { method: request.method })
  })
}

export class EditorRenderer {
  constructor({ editorPath, automated = false, offscreen = automated, onFailure }) {
    this.window = new BrowserWindow({
      title: 'EZ Tree · Seal Harness', width: 1440, height: 960, minWidth: 900, minHeight: 640,
      show: false, backgroundColor: '#17251c',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen },
    })
    if (offscreen) this.window.webContents.setFrameRate(30)
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', event => event.preventDefault())
    this.window.webContents.on('render-process-gone', (_event, details) => onFailure?.(new Error(`编辑器渲染进程退出：${details.reason}`)))
    this.window.webContents.on('console-message', event => {
      if (['warning', 'error'].includes(event.level)) process.stderr.write(`[editor] ${event.message}\n`)
    })
    this.window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    this.window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(ez-tree:|file:|data:|blob:|devtools:)/.test(details.url) })
    })
    this.ready = this.window.loadURL(`ez-tree://app/index.html${automated ? '?automation=1' : ''}`)
      .then(() => this.execute('Promise.resolve(window.ezTreeReady).then(() => Boolean(window.ezTree))'))
      .then(value => { if (!value) throw new Error('编辑器引擎接口未就绪。') })
  }

  async execute(script, timeout = 90_000) {
    let timer
    try {
      return await Promise.race([
        this.window.webContents.executeJavaScript(script),
        new Promise((_resolve, reject) => { timer = setTimeout(() => {
          this.close()
          reject(new Error('编辑器执行超时，请降低生成复杂度后重试。'))
        }, timeout) }),
      ])
    } finally { clearTimeout(timer) }
  }

  async call(method, value) {
    await this.ready
    if (!['listPresets', 'getPresetOptions', 'getOptions', 'setOptions', 'exportFile'].includes(method)) throw new Error('未知编辑器操作。')
    return this.execute(`window.ezTree[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`)
  }

  close() { if (!this.window.isDestroyed()) this.window.destroy() }
}
