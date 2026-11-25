import { app, dialog, Menu } from 'electron'
import { mkdir, readFile, unlink, writeFile, link } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { EditorRenderer, registerEditorProtocol } from './renderer.mjs'
import { dataDirectory, saveExport, saveChosenExport } from './paths.mjs'
import { optionsSchema, validateComplexity } from '../mcp/options.mjs'
import { existsSync, mkdirSync } from 'node:fs'
import { serveRenderer } from '../mcp/pipe.mjs'

export const VERSION = '0.1.0'

function argumentsFrom(argv) {
  const options = { hidden: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--mcp') throw new Error('MCP 请使用随包的 lib/mcp/cli.mjs 启动器及 ELECTRON_RUN_AS_NODE=1 环境，或直接使用 Seal 插件提供的连接配置。')
    else if (argument === '--no-window') options.hidden = true
    else if (['--verify', '--verify-ui', '--verify-full', '--render-pipe', '--render-token', '--account', '--output-dir', '--ready-file'].includes(argument)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少参数。`)
      options[({ '--verify': 'verify', '--verify-ui': 'verifyUi', '--verify-full': 'verifyUi', '--render-pipe': 'renderPipe', '--render-token': 'renderToken', '--account': 'account', '--output-dir': 'outputDirectory', '--ready-file': 'readyFile' })[argument]] = value
    } else if (argument === '--version') options.version = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument.startsWith('--')) throw new Error(`未知启动参数：${argument}`)
  }
  if ([options.verify, options.verifyUi, options.renderPipe].filter(Boolean).length > 1) throw new Error('不能同时使用多种运行模式。')
  if (Boolean(options.renderPipe) !== Boolean(options.renderToken)) throw new Error('渲染器连接参数不完整。')
  if (options.renderToken && !/^[a-f0-9]{64}$/.test(options.renderToken)) throw new Error('渲染器连接令牌无效。')
  return options
}

function usage() {
  return `EZ Tree ${VERSION} · Seal Harness\n\n用法：EZ-Tree [选项]\n  --output-dir <目录>   默认导出目录\n  --account <账号>      使用独立账号数据目录\n  --verify <目录>       隐藏运行真实生成与导出验收并退出\n  --verify-ui <目录>    隐藏运行完整编辑器验收并保存截图\n  --no-window           隐藏编辑器运行，用于生命周期验收\n  --ready-file <文件>   编辑器就绪后写入状态文件\n  --version             查看版本\n\nMCP：使用 Seal 插件提供的内嵌 Node 启动器连接配置。\n示例：EZ-Tree --verify ./verification\n`
}

async function installMenu(editor, outputDirectory) {
  const guarded = operation => async () => {
    try { await operation() }
    catch (error) { await dialog.showMessageBox(editor.window, { type: 'error', title: 'EZ Tree', message: error.message }) }
  }
  const exportAs = format => guarded(async () => {
    const result = await dialog.showSaveDialog(editor.window, {
      title: `导出 ${format.toUpperCase()}`, defaultPath: join(outputDirectory, `tree.${format}`),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (result.canceled || !result.filePath) return
    const value = await editor.call('exportFile', { format })
    await saveChosenExport(result.filePath, format, value.base64)
    await dialog.showMessageBox(editor.window, { type: 'info', title: '导出完成', message: `已保存到 ${result.filePath}` })
  })
  const open = guarded(async () => {
    const result = await dialog.showOpenDialog(editor.window, { title: '打开树木项目', properties: ['openFile'], filters: [{ name: 'EZ Tree 项目', extensions: ['json'] }] })
    if (result.canceled) return
    const bytes = await readFile(result.filePaths[0])
    if (bytes.length > 1024 * 1024) throw new Error('项目文件超过 1 MiB。')
    const options = optionsSchema.parse(JSON.parse(bytes.toString('utf8')))
    const current = await editor.call('getOptions')
    const { mergeOptions } = await import('../mcp/options.mjs')
    validateComplexity(mergeOptions(current, options))
    await editor.call('setOptions', { options })
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '打开 JSON 项目…', accelerator: 'CmdOrCtrl+O', click: open },
      { label: '保存 JSON 项目…', accelerator: 'CmdOrCtrl+S', click: exportAs('json') },
      { type: 'separator' }, { label: '导出 GLB 模型…', click: exportAs('glb') },
      { label: '导出 PNG 图片…', click: exportAs('png') }, { type: 'separator' }, { role: 'quit', label: '退出' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '帮助', submenu: [{ label: `关于 EZ Tree ${VERSION}`, click: guarded(() => dialog.showMessageBox(editor.window, {
      title: '关于 EZ Tree', message: `EZ Tree ${VERSION}`, detail: '基于 Daniel Greenheck 的 EZ-Tree（MIT）。\n完整编辑器、MCP 和技能由 dsh-ez-tree 统一交付。',
    })) }] },
  ]))
}

async function verify(editor, directory, mode = 'engine') {
  await mkdir(directory, { recursive: true })
  const presets = await editor.call('listPresets')
  if (!presets.length) throw new Error('没有可用预设。')
  const preset = presets.includes('Ash Small') ? 'Ash Small' : presets[0]
  const generated = await editor.call('setOptions', { preset, options: { seed: 12345 } })
  if (!(generated.vertexCount > 0) || !(generated.triangleCount > 0)) throw new Error('未生成有效树木几何。')
  const selectedPreset = await editor.execute("document.querySelector('#ui-container select')?.selectedOptions[0]?.textContent")
  if (selectedPreset !== preset) throw new Error(`界面预设与实际生成预设不一致：${selectedPreset}`)
  const artifacts = []
  for (const format of ['glb', 'png', 'json']) {
    const exported = await editor.call('exportFile', { format })
    const bytes = Buffer.from(exported.base64, 'base64')
    if (format === 'glb' && bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('GLB 文件头无效。')
    if (format === 'png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG 文件头无效。')
    if (format === 'json' && JSON.parse(bytes.toString()).seed !== 12345) throw new Error('JSON 项目参数不一致。')
    artifacts.push(await saveExport(directory, format, `verification-${Date.now()}`, exported.base64))
  }
  if (mode === 'full-ui') {
    const screenshot = await editor.window.webContents.capturePage()
    await writeFile(join(directory, 'editor.png'), screenshot.toPNG())
  }
  const result = { version: VERSION, mode, verifiedAt: new Date().toISOString(), executable: process.execPath,
    platform: process.platform, arch: process.arch, presets: presets.length, selectedPreset, generated, artifacts }
  await writeFile(join(directory, 'verification.json'), JSON.stringify(result, null, 2) + '\n')
  process.stderr.write(`EZ Tree verification passed: ${artifacts.length} artifacts\n`)
}

async function main() {
  const options = argumentsFrom(process.argv.slice(app.isPackaged ? 1 : 2))
  if (options.help || options.version) {
    return process.stdout.write(options.version ? `${VERSION}\n` : usage(), () => app.exit(0))
  }
  app.setName('EZ-Tree')
  if (process.platform === 'win32') app.setAppUserModelId('com.asun-labs.ez-tree')
  const data = dataDirectory({ home: process.env.DSH_HOME || join(homedir(), '.seal-harness'), account: options.account })
  const outputDirectory = resolve(options.outputDirectory || join(data, 'exports'))
  const browserData = join(data, 'browser', options.renderPipe ? `mcp-${process.pid}` : 'gui')
  mkdirSync(browserData, { recursive: true })
  app.setPath('userData', browserData)
  app.setPath('sessionData', browserData)
  await mkdir(outputDirectory, { recursive: true })
  let editor
  let pipe
  let shuttingDown = false
  let ownsReadyFile = false
  const shutdown = async (code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    const timer = setTimeout(() => app.exit(code), 3000)
    timer.unref()
    try {
      pipe?.destroy()
      editor?.close()
      if (ownsReadyFile) await unlink(resolve(options.readyFile)).catch(error => { if (error.code !== 'ENOENT') throw error })
    } catch (error) { process.stderr.write(`${error.message}\n`) }
    app.exit(code)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  app.on('window-all-closed', () => { if (!options.renderPipe) void shutdown() })
  app.on('before-quit', () => { if (ownsReadyFile) void unlink(resolve(options.readyFile)).catch(() => {}) })
  await app.whenReady()
  const packagedEditor = join(app.getAppPath(), 'lib', 'editor', 'index.html')
  const editorPath = existsSync(packagedEditor) ? packagedEditor : resolve(import.meta.dirname, '../editor/index.html')
  registerEditorProtocol(editorPath)
  editor = new EditorRenderer({ editorPath,
    automated: Boolean(options.verify || options.renderPipe), onFailure: error => { process.stderr.write(`${error.message}\n`); void shutdown(1) } })
  await editor.ready
  if (options.verify || options.verifyUi) {
    await verify(editor, resolve(options.verify || options.verifyUi), options.verifyUi ? 'full-ui' : 'engine')
    return shutdown()
  }
  if (options.renderPipe) {
    pipe = await serveRenderer({ endpoint: options.renderPipe, token: options.renderToken, editor, onClose: () => void shutdown() })
  } else {
    await installMenu(editor, outputDirectory)
    if (!options.hidden) editor.window.showInactive()
  }
  if (options.readyFile) {
    const destination = resolve(options.readyFile)
    const temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({
        ready: true, pid: process.pid, version: VERSION, mode: options.renderPipe ? 'renderer' : 'gui',
        executable: process.execPath, dataDirectory: data, outputDirectory,
      }) + '\n', { flag: 'wx' })
      await link(temporary, destination)
      ownsReadyFile = true
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
}

main().catch(error => { process.stderr.write(`EZ Tree startup failed: ${error.stack ?? error.message}\n`); app.exit(1) })
