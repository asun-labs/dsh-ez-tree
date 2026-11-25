import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { mergeOptions, checkComplexity } from './options.js'
import { setupUI } from './ui.js'
import { createEmbeddedBridge } from './embed-bridge.mjs'
import { createBrowserTransport } from './browser-transport.mjs'
import { validateProject, optionChanges, verifyProjectOptions } from './embed-project.mjs'
import './styles.css'
import './embed.css'

const automation = new URLSearchParams(location.search).has('automation')
const browserPage = /^\/view\/[^/]+\/index\.html$/.test(location.pathname)
const embedded = browserPage || new URLSearchParams(location.search).has('embedded')
const state = { renderer: null, project: null, disposed: false, visible: true, cleanups: [] }
let sessionBridge
let frame
let resize
let uiBusy = false
document.body.classList.toggle('embedded', embedded)
const manager = THREE.DefaultLoadingManager
let pendingAssets = 0
const failedAssets = []
const start = manager.itemStart.bind(manager)
const end = manager.itemEnd.bind(manager)
manager.itemStart = (url) => { pendingAssets++; start(url) }
manager.itemEnd = (url) => { pendingAssets--; end(url) }
manager.onError = url => failedAssets.push(url)

export function report(message, error = false) {
  const status = document.getElementById('status')
  status.textContent = message
  status.dataset.error = String(error)
}

async function waitAssets() {
  const deadline = performance.now() + 60000
  while (true) {
    if (failedAssets.length) throw new Error(`资源加载失败：${failedAssets[0]}`)
    if (performance.now() > deadline) throw new Error('资源加载超时，请重新打开应用。')
    await new Promise(resolve => setTimeout(resolve, 25))
    if (pendingAssets === 0) return
  }
}

function fitTree() {
  state.tree.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(state.tree)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const distance = Math.max(size.y, size.x / state.camera.aspect, size.z, 1) * 1.4
  state.controls.maxDistance = Math.max(150, distance * 3)
  state.controls.target.copy(center)
  state.camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.12, distance * 0.3))
  state.camera.near = 0.01
  state.camera.far = Math.max(2000, distance * 5)
  state.camera.updateProjectionMatrix()
  state.controls.update()
}

const getOptions = () => JSON.parse(JSON.stringify(state.tree.options))
function metrics() { return { options: getOptions(), vertexCount: state.tree.vertexCount, triangleCount: state.tree.triangleCount } }

async function applyOptions({ preset, options = {} } = {}) {
  if (preset !== undefined && !Object.hasOwn(state.presets, preset)) throw new Error(`未知预设：${preset}`)
  const base = preset === undefined ? getOptions() : state.presets[preset]
  const next = mergeOptions(base, options)
  checkComplexity(next)
  state.tree.options.copy(next)
  state.tree.generate()
  state.acceptedOptions = getOptions()
  fitTree()
  if (preset !== undefined && state.selection) state.selection.preset = preset
  state.refreshing = true
  try { state.pane?.refresh() }
  finally { state.refreshing = false }
  return metrics()
}

async function setOptions(request = {}) {
  if (!embedded) return applyOptions(request)
  if (!state.project) throw new Error('正在等待当前会话项目，请稍后操作。')
  const intent = { expectedRevision: state.project.revision }
  if (request.preset !== undefined) intent.preset = request.preset
  if (request.options !== undefined) {
    const next = mergeOptions(state.acceptedOptions, request.options)
    intent.options = optionChanges(state.acceptedOptions, next)
  }
  try { return await sessionBridge.requestIntent(intent) }
  catch (error) { restoreAccepted(); throw error }
}

function refreshPane() {
  state.refreshing = true
  try { state.pane?.refresh() }
  finally { state.refreshing = false }
}

function restoreAccepted() {
  if (state.disposed || !state.tree || !state.acceptedOptions) return
  state.tree.options.copy(state.acceptedOptions)
  if (state.project?.preset && Object.hasOwn(state.presets, state.project.preset)) state.selection.preset = state.project.preset
  refreshPane()
}

function updateUiDisabled() {
  if (state.pane && !state.disposed) state.pane.disabled = embedded && (uiBusy || !state.project)
}

async function applyProject(project) {
  const snapshot = validateProject(project, state.project, state.acceptedOptions)
  const previousOptions = structuredClone(state.acceptedOptions)
  const previousPreset = state.selection.preset
  let result, digest
  try {
    if (snapshot.preset && Object.hasOwn(state.presets, snapshot.preset)) state.selection.preset = snapshot.preset
    result = await applyOptions({ options: snapshot.options })
    digest = await verifyProjectOptions(snapshot, getOptions())
  } catch (failure) {
    state.selection.preset = previousPreset
    try { await applyOptions({ options: previousOptions }) }
    catch (restore) { throw new AggregateError([failure, restore], '树木参数确认失败，且无法恢复先前视图，请重新加载编辑器。') }
    throw failure
  }
  state.project = { ...snapshot, options: getOptions(), optionsDigest: digest }
  updateUiDisabled()
  report(`会话树木 · 修订 ${snapshot.revision}`)
  return { vertexCount: result.vertexCount, triangleCount: result.triangleCount,
    revision: snapshot.revision, optionsDigest: digest }
}

async function exportProject({ format, revision } = {}) {
  if (!state.project || revision !== state.project.revision) throw new Error('导出修订与当前项目不一致。')
  if (sessionBridge.pendingMutation) throw new Error('参数尚未提交，请等待修改完成后导出。')
  await verifyProjectOptions(state.project, getOptions())
  const exported = await exportFile({ format })
  const digest = await verifyProjectOptions(state.project, getOptions())
  const buffer = Uint8Array.from(atob(exported.base64), character => character.charCodeAt(0)).buffer
  return { buffer, mimeType: exported.mimeType, extension: exported.extension,
    revision: state.project.revision, optionsDigest: digest }
}

async function requestExport(format) {
  if (!embedded) return null
  if (!state.project) throw new Error('当前会话项目尚未就绪。')
  return sessionBridge.requestIntent({ expectedRevision: state.project.revision, export: { format } })
}

async function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('导出文件编码失败。'))
    reader.readAsDataURL(blob)
  })
}

function treeOnly(callback) {
  const hidden = []
  const fog = state.scene.fog
  const alpha = state.renderer.getClearAlpha()
  const color = state.renderer.getClearColor(new THREE.Color())
  const background = state.scene.background
  try {
    for (const object of state.scene.children) {
      // 环境光仍参与树木渲染；仅隐藏环境中的几何表面。
      if (object === state.tree) continue
      // Skybox 是 Mesh 且拥有太阳/环境光；改层只屏蔽表面，不隐藏其灯光子树。
      object.traverse(node => { if (node.isMesh) { hidden.push([node, node.layers.mask]); node.layers.mask = 0 } })
    }
    state.scene.fog = null
    state.scene.background = null
    state.renderer.setClearColor(0, 0)
    return callback()
  } finally {
    for (const [node, mask] of hidden) node.layers.mask = mask
    state.scene.fog = fog
    state.scene.background = background
    state.renderer.setClearColor(color, alpha)
  }
}

async function exportFile({ format } = {}) {
  await waitAssets()
  let blob
  if (format === 'json') blob = new Blob([JSON.stringify(getOptions(), null, 2)], { type: 'application/json' })
  else if (format === 'glb') {
    const bytes = await new GLTFExporter().parseAsync(state.tree, { binary: true })
    blob = new Blob([bytes], { type: 'model/gltf-binary' })
  } else if (format === 'png') {
    let url
    try {
      state.tree.update(0)
      url = treeOnly(() => {
        state.renderer.render(state.scene, state.camera)
        return state.renderer.domElement.toDataURL('image/png')
      })
    } finally { state.tree.update(state.elapsed ?? 0) }
    return { base64: url.split(',')[1], mimeType: 'image/png', extension: 'png' }
  } else throw new Error('导出格式必须为 glb、png 或 json。')
  return { base64: await toBase64(blob), mimeType: blob.type, extension: format }
}

async function initialize() {
  const { Tree, TreePreset } = await import('@dgreenheck/ez-tree')
  if (state.disposed) throw new Error('编辑器已关闭。')
  const container = document.getElementById('app')
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  state.renderer = renderer
  renderer.setPixelRatio(automation ? 1 : Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 2
  renderer.setSize(container.clientWidth, container.clientHeight)
  container.append(renderer.domElement)
  let composition
  if (automation) {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, .1, 2000)
    const controls = new OrbitControls(camera, renderer.domElement)
    const tree = new Tree()
    tree.loadPreset('Ash Medium')
    scene.add(tree, new THREE.HemisphereLight(0xffffff, 0x606060, 2))
    const sun = new THREE.DirectionalLight(0xffffff, 3)
    sun.position.set(30, 80, 40)
    scene.add(sun)
    composition = { scene, camera, controls, tree }
  } else {
    const { createScene } = await import('../vendor/ez-tree/src/app/scene.js')
    composition = await createScene(renderer)
  }
  if (state.disposed) {
    releaseScene(composition.scene)
    composition.controls.dispose()
    throw new Error('编辑器已关闭。')
  }
  Object.assign(state, composition, { renderer, presets: TreePreset })
  state.acceptedOptions = getOptions()
  await waitAssets()
  if (state.disposed) throw new Error('编辑器已关闭。')
  fitTree()
  state.pane = setupUI(state, { setOptions, exportFile, getOptions, report, embedded, requestExport, refreshPane, restoreAccepted })
  updateUiDisabled()
  const clock = new THREE.Clock()
  state.render = function render() {
    if (state.disposed || !state.visible) return
    const elapsed = clock.getElapsedTime()
    state.elapsed = elapsed
    state.tree.update(elapsed)
    state.scene.getObjectByName('Forest')?.children.forEach(tree => tree.update(elapsed))
    state.environment?.update(elapsed)
    state.controls.update()
    renderer.render(state.scene, state.camera)
    if (!automation) frame = requestAnimationFrame(state.render)
  }
  state.render()
  resize = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight)
    state.camera.aspect = container.clientWidth / container.clientHeight
    state.camera.updateProjectionMatrix()
  })
  resize.observe(container)
  document.getElementById('loading-screen').style.display = 'none'
  window.ezTree = { listPresets: async () => Object.keys(TreePreset),
    getPresetOptions: name => {
      if (!Object.hasOwn(TreePreset, name)) throw new Error(`未知预设：${name}`)
      return structuredClone(TreePreset[name])
    }, getOptions, setOptions, exportFile, metrics }
  if (browserPage) Object.assign(window.ezTree, {
    ready: sessionBridge.ready,
    readProject: () => sessionBridge.readProject(),
    async getOptions() {
      const project = await sessionBridge.readProject()
      if (!project) throw new Error('当前会话项目尚未就绪。')
      return structuredClone(project.options)
    },
    async setOptions(request = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['expectedRevision', 'preset', 'options'].includes(key))) throw new Error('参数修改只接受预设、参数和当前修订号。')
      await sessionBridge.ready
      const project = await sessionBridge.readProject()
      return sessionBridge.requestIntent({ expectedRevision: request.expectedRevision ?? project.revision,
        ...(request.preset !== undefined ? { preset: request.preset } : {}), ...(request.options !== undefined ? { options: request.options } : {}) })
    },
    exportFile: request => sessionBridge.exportFile(request),
    async metrics() {
      const project = await sessionBridge.readProject()
      if (!project || state.project?.revision !== project.revision) throw new Error('项目仍在同步，请稍后重试。')
      const digest = await verifyProjectOptions(project, getOptions())
      return { ...metrics(), revision: project.revision, optionsDigest: digest }
    },
  })
  report(embedded ? '正在等待当前会话的树木项目…' : '拖动旋转 · 滚轮缩放 · 右键平移')
  return true
}

function listen(element, type, handler) {
  element.addEventListener(type, handler)
  state.cleanups.push(() => element.removeEventListener(type, handler))
}

listen(document.getElementById('audio-toggle'), 'click', async event => {
  const audio = document.getElementById('background-audio')
  try { if (audio.paused) { await audio.play(); event.target.textContent = '暂停环境音' } else { audio.pause(); event.target.textContent = '播放环境音' } }
  catch (error) { report(`无法播放环境音：${error.message}`, true) }
})
listen(document.getElementById('about-toggle'), 'click', () => document.getElementById('about').showModal())
listen(document.getElementById('about-close'), 'click', () => document.getElementById('about').close())
function setVisible({ visible } = {}) {
  if (typeof visible !== 'boolean') throw new Error('编辑器可见状态无效。')
  cancelAnimationFrame(frame)
  state.visible = visible
  if (visible) state.render?.()
  return { visible }
}

function releaseScene(scene) {
  const geometries = new Set(), materials = new Set(), textures = new Set()
  scene?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry)
    for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) {
      materials.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
    }
  })
  geometries.forEach(value => value.dispose())
  materials.forEach(value => value.dispose())
  textures.forEach(value => value.dispose())
}

function disposeEditor() {
  if (state.disposed) return { disposed: true }
  state.disposed = true
  cancelAnimationFrame(frame)
  resize?.disconnect()
  state.pane?.dispose()
  state.controls?.dispose()
  releaseScene(state.scene)
  state.renderer?.dispose()
  state.renderer?.forceContextLoss()
  const audio = document.getElementById('background-audio')
  audio.pause()
  state.cleanups.splice(0).forEach(cleanup => cleanup())
  return { disposed: true }
}

if (embedded) {
  const transport = browserPage ? createBrowserTransport : createEmbeddedBridge
  sessionBridge = transport({ ready: () => window.ezTreeReady,
    handlers: { applyProject, exportFile: exportProject, restore: restoreAccepted, setVisible, dispose: disposeEditor },
    onBusy: value => { uiBusy = value; updateUiDisabled() }, report })
  const toggle = document.getElementById('parameters-toggle')
  toggle.hidden = false
  const toggleParameters = () => {
    const opened = document.body.classList.toggle('parameters-open')
    toggle.setAttribute('aria-expanded', String(opened))
  }
  listen(toggle, 'click', toggleParameters)
}
addEventListener('beforeunload', () => { sessionBridge?.dispose(); disposeEditor() }, { once: true })
window.ezTreeReady = initialize()
window.ezTreeReady.catch(error => { report(error.message, true); document.getElementById('loading-text').textContent = error.message })
