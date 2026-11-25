import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

// 可用独立验证环境的 Playwright；不进入运行包。
const { chromium } = await import(process.env.EZ_TREE_PLAYWRIGHT_MODULE || 'playwright')
const root = resolve('lib/editor')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' }
const server = createServer(async (request, response) => {
  const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname)
  if (!path.startsWith(root + sep) && path !== root) { response.writeHead(403).end(); return }
  try { const file = path === root ? resolve(root, 'index.html') : path; response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); response.end(await readFile(file)) }
  catch { response.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const base = `http://127.0.0.1:${server.address().port}`
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/index.html?automation=1')
  await page.evaluate(() => window.ezTreeReady)
  const presets = await page.evaluate(() => window.ezTree.listPresets())
  assert.equal(presets.length, 15)
  for (const preset of presets) {
    const stats = await page.evaluate(preset => window.ezTree.setOptions({ preset }), preset)
    assert.ok(stats.vertexCount > 0 && stats.triangleCount > 0, preset)
  }
  await page.evaluate(() => window.ezTree.setOptions({ preset: 'Oak Small', options: { seed: 42 } }))
  const artifacts = await page.evaluate(async () => ({ glb: await window.ezTree.exportFile({ format: 'glb' }), png: await window.ezTree.exportFile({ format: 'png' }), json: await window.ezTree.exportFile({ format: 'json' }) }))
  const glb = Buffer.from(artifacts.glb.base64, 'base64')
  assert.equal(glb.toString('utf8', 0, 4), 'glTF')
  assert.equal(glb.readUInt32LE(4), 2)
  const jsonLength = glb.readUInt32LE(12)
  const doc = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength))
  assert.ok(doc.images?.length >= 2)
  assert.ok(doc.images.every(image => image.bufferView !== undefined))
  const png = Buffer.from(artifacts.png.base64, 'base64')
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a')
  assert.equal(JSON.parse(Buffer.from(artifacts.json.base64, 'base64').toString()).seed, 42)
  await mkdir('.validation', { recursive: true })
  await writeFile('.validation/tree.glb', glb)
  await writeFile('.validation/tree.png', png)
  await page.screenshot({ path: '.validation/editor-automation.png' })
  assert.deepEqual(errors, [])
  // 完整环境使用另一页面加载，保证交互应用未被自动化简化路径替代。
  await page.goto(base + '/index.html')
  await page.evaluate(() => window.ezTreeReady)
  await page.screenshot({ path: '.validation/editor-full.png' })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ presets: presets.length, glbBytes: glb.length, pngBytes: png.length, offlineTextures: doc.images.length, fullEditor: true }))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
