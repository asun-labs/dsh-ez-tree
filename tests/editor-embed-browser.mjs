import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { optionsDigest } from '../plugin/projects.mjs'

const { chromium } = await import(process.env.EZ_TREE_PLAYWRIGHT_MODULE || 'playwright')
const root = resolve('lib/editor')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' }
const server = createServer(async (request, response) => {
  if (request.url === '/host') return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><iframe id="editor" title="树木编辑器" src="/index.html?embedded=1" style="width:400px;height:720px;border:0"></iframe>')
  const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname)
  if (!path.startsWith(root + sep)) return response.writeHead(403).end()
  try { response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); response.end(await readFile(path)) }
  catch { response.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const digest = optionsDigest
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/host`)
  console.log('embedded iframe loaded')
  const frame = page.frames().find(frame => frame.url().includes('?embedded=1'))
  await page.evaluate(() => new Promise((resolve, reject) => {
    const iframe = document.getElementById('editor')
    const pair = new MessageChannel()
    let sequence = 0
    const requests = new Map()
    window.intents = []
    window.editorCall = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('editor RPC timed out')) }, 30000)
      requests.set(id, { resolve, reject, timer })
      pair.port1.postMessage({ id, method, params })
    })
    window.answerIntent = message => pair.port1.postMessage({ type: 'intent-result', ...message })
    pair.port1.onmessage = event => {
      const message = event.data
      if (message.type === 'ready') return resolve(message)
      if (message.type === 'error') return reject(new Error(message.error))
      if (message.type === 'intent') return window.intents.push(message)
      const pending = requests.get(message.id)
      if (!pending) return
      requests.delete(message.id); clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    }
    pair.port1.start()
    iframe.contentWindow.postMessage({ type: 'dsh-ez-tree/connect', version: 1, channelId: crypto.randomUUID() }, location.origin, [pair.port2])
  }))
  const projectOptions = JSON.parse(await readFile('vendor/ez-tree/src/lib/presets/pine_small.json'))
  projectOptions.seed = 97531
  const project = { projectId: 'test-session-project', revision: 1, preset: 'Pine Small', options: projectOptions, optionsDigest: digest(projectOptions) }
  const metrics = await page.evaluate(project => window.editorCall('applyProject', project), project)
  console.log('embedded project applied')
  assert.ok(metrics.vertexCount > 100 && metrics.triangleCount > 100)
  assert.equal(metrics.optionsDigest, project.optionsDigest)
  assert.equal(await frame.locator('#ui-container select').first().evaluate(select => select.selectedOptions[0].textContent), 'Pine Small')
  for (const width of [300, 500]) {
    await page.evaluate(width => { document.getElementById('editor').style.width = width + 'px' }, width)
    await frame.waitForTimeout(50)
    const canvas = await frame.locator('#app canvas').boundingBox()
    assert.ok(canvas.width >= width - 1 && canvas.height > 600, 'real 3D viewport stays visible in a narrow session pane')
  }
  await frame.locator('#parameters-toggle').click()
  const editingViewport = await frame.locator('#app canvas').boundingBox()
  assert.ok(editingViewport.width >= 499 && editingViewport.height >= 300, 'opening controls retains a real visible 3D area')
  const seedRow = frame.locator('.tp-lblv').filter({ has: frame.locator('.tp-lblv_l', { hasText: /^seed$/ }) })
  const seedInput = seedRow.locator('input').first()
  await seedInput.fill('24680')
  await seedInput.press('Enter')
  await page.waitForFunction(() => window.intents.length === 1)
  console.log('manual intent received')
  const intent = await page.evaluate(() => window.intents[0])
  assert.equal(intent.intent.expectedRevision, 1)
  assert.deepEqual(intent.intent.options, { seed: 24680 })
  const blocked = await page.evaluate(() => window.editorCall('exportFile', { format: 'json', revision: 1 }).then(() => false, error => error.message))
  assert.match(blocked, /尚未提交/)
  const nextOptions = { ...projectOptions, seed: 24680 }
  const nextProject = { ...project, revision: 2, options: nextOptions, optionsDigest: digest(nextOptions) }
  await page.evaluate(project => window.editorCall('applyProject', project), nextProject)
  await page.evaluate(({ id, project }) => window.answerIntent({ id, ok: true, project }), { id: intent.id, project: nextProject })
  await frame.waitForFunction(() => !document.querySelector('#ui-container input').disabled)
  const exported = await page.evaluate(async () => {
    const json = await window.editorCall('exportFile', { format: 'json', revision: 2 })
    const glb = await window.editorCall('exportFile', { format: 'glb', revision: 2 })
    const png = await window.editorCall('exportFile', { format: 'png', revision: 2 })
    const view = new DataView(glb.buffer)
    const document = JSON.parse(new TextDecoder().decode(new Uint8Array(glb.buffer, 20, view.getUint32(12, true))).trim())
    return { seed: JSON.parse(new TextDecoder().decode(json.buffer)).seed,
      revision: json.revision, digest: json.optionsDigest, glbMagic: new TextDecoder().decode(new Uint8Array(glb.buffer, 0, 4)),
      images: document.images.length, pngMagic: [...new Uint8Array(png.buffer, 0, 8)], glbBytes: glb.buffer.byteLength }
  })
  console.log('binary exports verified')
  assert.equal(exported.seed, 24680)
  assert.equal(exported.revision, 2)
  assert.equal(exported.digest, nextProject.optionsDigest)
  assert.equal(exported.glbMagic, 'glTF')
  assert.ok(exported.images >= 2)
  assert.deepEqual(exported.pngMagic, [137, 80, 78, 71, 13, 10, 26, 10])
  await assert.rejects(page.evaluate(project => window.editorCall('applyProject', project), project), /过期/)
  await page.evaluate(project => window.editorCall('applyProject', { ...project, force: true }), project)
  await frame.getByText('导入与导出', { exact: true }).click()
  await frame.getByText('导出 GLB 模型', { exact: true }).click()
  await page.waitForFunction(() => window.intents.length === 2)
  const exportIntent = await page.evaluate(() => window.intents[1])
  assert.deepEqual(exportIntent.intent.export, { format: 'glb' })
  await page.evaluate(() => window.editorCall('exportFile', { format: 'glb', revision: 1 }))
  await page.evaluate(id => window.answerIntent({ id, ok: true, artifact: { path: '/workspace/session-tree.glb' } }), exportIntent.id)
  await frame.getByText('已保存到：/workspace/session-tree.glb', { exact: true }).waitFor()
  await mkdir('.validation', { recursive: true })
  await frame.locator('#parameters-toggle').click()
  await frame.waitForTimeout(200)
  await frame.locator('body').screenshot({ path: '.validation/editor-embedded.png' })
  assert.deepEqual(await page.evaluate(() => window.editorCall('dispose')), { disposed: true })
  assert.equal(await frame.evaluate(() => document.querySelector('#app canvas').getContext('webgl2').isContextLost()), true)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, actualCanvas: true, manualAndToolState: true, binaryExports: exported, screenshot: '.validation/editor-embedded.png' }))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
