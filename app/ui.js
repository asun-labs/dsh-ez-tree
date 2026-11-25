import { Pane } from 'tweakpane'
import { numberRange, enums } from './options.js'

function leafBindings(folder, object, prefix) {
  for (const [key, value] of Object.entries(object)) {
    const path = `${prefix}.${key}`
    if (value && typeof value === 'object') {
      const group = folder.addFolder({ title: key, expanded: false })
      leafBindings(group, value, path)
    } else if (enums[path]) folder.addBinding(object, key, { options: Object.fromEntries(enums[path].map(value => [value, value])) })
    else if (key === 'tint') folder.addBinding(object, key, { view: 'color' })
    else if (typeof value === 'number') {
      const [min, max, step] = numberRange(path)
      folder.addBinding(object, key, { min, max, ...(step ? { step } : {}) })
    } else folder.addBinding(object, key)
  }
}

async function download(exportFile, format) {
  const result = await exportFile({ format })
  const raw = atob(result.base64)
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }))
  const link = document.getElementById('downloadLink')
  link.href = url
  link.download = `tree.${result.extension}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export function setupUI(state, api) {
  const pane = new Pane({ container: document.getElementById('ui-container'), title: 'EZ Tree · 参数编辑器' })
  const tab = pane.addTab({ pages: [{ title: '参数' }, { title: '导入与导出' }] })
  const treeFolder = tab.pages[0].addFolder({ title: 'Tree · 树木', expanded: true })
  const selection = state.selection = { preset: 'Ash Medium' }
  const presetBinding = treeFolder.addBinding(selection, 'preset', { options: Object.fromEntries(Object.keys(state.presets).map(name => [name, name])) })
  presetBinding.on('change', async event => {
    if (state.refreshing) return
    try { await api.setOptions({ preset: event.value }); api.report(`已加载 ${event.value}`) }
    catch (error) { api.report(error.message, true) }
  })
  const run = async callback => {
    try { await callback(); pane.refresh(); api.report('参数已更新') }
    catch (error) { state.tree.options.copy(state.acceptedOptions); state.tree.generate(); pane.refresh(); api.report(error.message, true) }
  }
  const controls = treeFolder.addFolder({ title: '生成参数', expanded: true })
  const [seedMin, seedMax, seedStep] = numberRange('seed')
  controls.addBinding(state.tree.options, 'seed', { min: seedMin, max: seedMax, step: seedStep })
  controls.addBinding(state.tree.options, 'type', { options: { deciduous: 'deciduous', evergreen: 'evergreen' } })
  controls.on('change', () => { if (!state.refreshing) return run(() => api.setOptions({ options: api.getOptions() })) })
  for (const [key, title] of [['bark', 'Bark · 树皮'], ['branch', 'Branches · 分枝'], ['leaves', 'Leaves · 叶片']]) {
    const folder = treeFolder.addFolder({ title, expanded: false })
    leafBindings(folder, state.tree.options[key], key)
    folder.on('change', () => { if (!state.refreshing) return run(() => api.setOptions({ options: api.getOptions() })) })
  }
  const camera = tab.pages[0].addFolder({ title: 'Camera · 镜头', expanded: false })
  camera.addBinding(state.controls, 'autoRotate')
  camera.addBinding(state.controls, 'autoRotateSpeed', { min: 0, max: 2 })
  if (state.environment) {
    const environment = tab.pages[0].addFolder({ title: 'Environment · 环境', expanded: false })
    environment.addBinding(state.environment.skybox, 'sunAzimuth', { min: 0, max: 360 })
    environment.addBinding(state.environment.grass, 'instanceCount', { min: 0, max: 25000, step: 1 })
  }
  const info = tab.pages[0].addFolder({ title: 'Info · 模型信息', expanded: false })
  info.addBinding(state.tree, 'vertexCount', { readonly: true, label: '顶点数' })
  info.addBinding(state.tree, 'triangleCount', { readonly: true, label: '三角面数' })
  const exports = tab.pages[1]
  for (const [title, format] of [['保存参数 JSON', 'json'], ['导出 GLB 模型', 'glb'], ['导出透明 PNG', 'png']]) {
    exports.addButton({ title }).on('click', async () => {
      try { await download(api.exportFile, format); api.report(`已导出 tree.${format}`) }
      catch (error) { api.report(`导出失败：${error.message}`, true) }
    })
  }
  exports.addButton({ title: '导入参数 JSON' }).on('click', () => document.getElementById('fileInput').click())
  document.getElementById('fileInput').addEventListener('change', async event => {
    const file = event.target.files[0]
    if (!file) return
    try {
      if (file.size > 65536) throw new Error('参数文件不能超过 64 KiB。')
      const options = JSON.parse(await file.text())
      await api.setOptions({ options })
      api.report(`已导入 ${file.name}`)
    } catch (error) { api.report(`导入失败：${error.message}`, true) }
    finally { event.target.value = '' }
  })
  return pane
}
