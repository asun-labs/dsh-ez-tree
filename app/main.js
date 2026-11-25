import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { mergeOptions, checkComplexity } from './options.js'
import { setupUI } from './ui.js'
import './styles.css'

const automation = new URLSearchParams(location.search).has('automation')
const state = { renderer: null }
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

async function setOptions({ preset, options = {} } = {}) {
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
      object.traverse(node => { if (node.isMesh) { hidden.push([node, node.visible]); node.visible = false } })
    }
    state.scene.fog = null
    state.scene.background = null
    state.renderer.setClearColor(0, 0)
    return callback()
  } finally {
    for (const [node, visible] of hidden) node.visible = visible
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
    const url = treeOnly(() => {
      state.renderer.render(state.scene, state.camera)
      return state.renderer.domElement.toDataURL('image/png')
    })
    return { base64: url.split(',')[1], mimeType: 'image/png', extension: 'png' }
  } else throw new Error('导出格式必须为 glb、png 或 json。')
  return { base64: await toBase64(blob), mimeType: blob.type, extension: format }
}

async function initialize() {
  const { Tree, TreePreset } = await import('@dgreenheck/ez-tree')
  const container = document.getElementById('app')
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
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
  Object.assign(state, composition, { renderer, presets: TreePreset })
  state.acceptedOptions = getOptions()
  await waitAssets()
  fitTree()
  state.pane = setupUI(state, { setOptions, exportFile, getOptions, report })
  const clock = new THREE.Clock()
  let frame
  function render() {
    const elapsed = clock.getElapsedTime()
    state.tree.update(elapsed)
    state.scene.getObjectByName('Forest')?.children.forEach(tree => tree.update(elapsed))
    state.environment?.update(elapsed)
    state.controls.update()
    renderer.render(state.scene, state.camera)
    if (!automation) frame = requestAnimationFrame(render)
  }
  render()
  const resize = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight)
    state.camera.aspect = container.clientWidth / container.clientHeight
    state.camera.updateProjectionMatrix()
  })
  resize.observe(container)
  addEventListener('beforeunload', () => { cancelAnimationFrame(frame); resize.disconnect(); state.controls.dispose(); renderer.dispose() })
  document.getElementById('loading-screen').style.display = 'none'
  window.ezTree = { listPresets: async () => Object.keys(TreePreset),
    getPresetOptions: name => {
      if (!Object.hasOwn(TreePreset, name)) throw new Error(`未知预设：${name}`)
      return structuredClone(TreePreset[name])
    }, getOptions, setOptions, exportFile, metrics }
  report('拖动旋转 · 滚轮缩放 · 右键平移')
  return true
}

document.getElementById('audio-toggle').addEventListener('click', async event => {
  const audio = document.getElementById('background-audio')
  try { if (audio.paused) { await audio.play(); event.target.textContent = '暂停环境音' } else { audio.pause(); event.target.textContent = '播放环境音' } }
  catch (error) { report(`无法播放环境音：${error.message}`, true) }
})
document.getElementById('about-toggle').addEventListener('click', () => document.getElementById('about').showModal())
document.getElementById('about-close').addEventListener('click', () => document.getElementById('about').close())
window.ezTreeReady = initialize()
window.ezTreeReady.catch(error => { report(error.message, true); document.getElementById('loading-text').textContent = error.message })
