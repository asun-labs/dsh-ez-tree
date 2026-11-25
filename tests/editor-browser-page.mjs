import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ProjectStore } from '../plugin/projects.mjs'
import { registerNativeEditor } from '../plugin/session-host.mjs'
import { BrowserPageService } from '../plugin/browser-page-service.mjs'

// Actual grant/cookie service + Host ProjectStore/tools + top-level real editor.
// BrowserSession placement itself is verified in the separate native desktop gate.
const { chromium } = await import(process.env.EZ_TREE_PLAYWRIGHT_MODULE || 'playwright')
const directory = resolve('.validation/browser-page')
await mkdir(directory, { recursive: true })
const root = await mkdtemp(join(directory, 'run-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)
const ctx = new Context()
ctx.provide('systemPrompt', { tools() { return () => {} } })
new ToolsService(ctx)
const providers = new Map()
ctx.provide('skills', { registerProvider(factory) {
  const provider = factory({ signal: new AbortController().signal, invalidate() {} })
  providers.set(provider.name, provider)
  return () => providers.delete(provider.name)
}, async list(options = {}) { return (await Promise.all([...providers.values()].map(provider => provider.list(options)))).flat() } })
const agent = { id: 'direct-browser-session' }
ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
ctx.provide('workingDirectory', { ensure: async value => { assert.equal(value.id, agent.id); return workspace } })
ctx.provide('connection', { admit() { throw new Error('standalone browser must not request broad owner credentials') } })
const store = new ProjectStore({ home: join(root, 'home'), renderTimeoutMs: 90000, watchTimeoutMs: 500 })
const editor = registerNativeEditor(ctx, { store, routes: false })
await editor.ready
const service = new BrowserPageService({ ctx, store, scope: editor.scope, assertScope: editor.assertScope,
  handlers: editor.handlers, editorDirectory: resolve('lib/editor'),
  checkView: async (scope, id, path) => {
    editor.assertScope(scope)
    assert.equal(id, agent.id)
    assert.equal(path, workspace)
  } })
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const execute = async (name, args = {}) => JSON.parse(await ctx.tools.get(name).execute(args, { agent, signal: new AbortController().signal }))
const until = async (predicate, message) => {
  const deadline = Date.now() + 30000
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await pause(25) }
}
const report = { fixture: 'actual isolated loopback grant service, fresh browser context, native ToolsService definition.execute and real top-level editor; no synthetic parent widget; not native BrowserSession placement', checks: [] }
try {
  const context = await browser.newContext({ viewport: { width: 650, height: 820 } })
  assert.deepEqual(await context.cookies(), [])
  const page = await context.newPage()
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url().includes('/api/')) requests.push({ path: new URL(request.url()).pathname, type: request.headers()['content-type'], bytes: request.postDataBuffer()?.byteLength ?? 0 }) })
  const launch = await service.launch(editor.scope(), agent.id, { workspace })
  const opening = execute('ez_tree_open_editor')
  opening.catch(() => {})
  await page.goto(launch.url)
  const opened = await opening
  await page.evaluate(() => window.ezTree.ready)
  assert.equal(opened.rendered, true)
  assert.equal(await page.evaluate(() => parent === window), true)
  assert.equal(await page.locator('iframe').count(), 0)
  assert.equal(new URL(page.url()).hash, '')
  assert.equal(await page.evaluate(() => document.cookie), '')
  const [cookie] = await context.cookies()
  assert.equal(cookie.name, 'ez-tree-view')
  assert.equal(cookie.httpOnly, true)
  assert.equal(cookie.sameSite, 'Strict')
  assert.match(cookie.path, /^\/view\/[^/]+\/$/)
  report.checks.push('fresh isolated context redeemed one-time grant into scoped HttpOnly cookie; no parent iframe or broad owner credential')
  console.log('Actual top-level browser page connected with its scoped cookie')
  const generated = await execute('ez_tree_editor_generate', { expectedRevision: 0, preset: 'Pine Small', options: { seed: 97531 } })
  assert.equal(generated.project.revision, 1)
  assert.equal(await page.evaluate(async () => (await window.ezTree.getOptions()).seed), 97531)
  await page.locator('#parameters-toggle').click()
  const input = page.locator('.tp-lblv').filter({ has: page.locator('.tp-lblv_l', { hasText: /^seed$/ }) }).locator('input').first()
  await input.fill('24680'); await input.press('Enter')
  await until(async () => (await store.read(editor.scope(), agent.id)).project?.options.seed === 24680, 'manual edit did not reach Host')
  await page.waitForFunction(() => !document.querySelector('#ui-container input').disabled)
  const changed = await page.evaluate(() => window.ezTree.setOptions({ expectedRevision: 2, options: { leaves: { size: 1.75 } } }))
  assert.equal(changed.revision, 3)
  assert.equal(changed.options.seed, 24680)
  const current = await execute('ez_tree_editor_get')
  assert.equal(current.project.optionsDigest, changed.optionsDigest)
  const actual = await page.evaluate(() => window.ezTree.metrics())
  assert.equal(actual.optionsDigest, changed.optionsDigest)
  assert.equal(actual.revision, 3)
  await assert.rejects(page.evaluate(() => window.ezTree.setOptions({ expectedRevision: 0, options: { seed: 1 } })), /更新|修订/)
  assert.equal((await execute('ez_tree_editor_get')).project.options.seed, 24680)
  await assert.rejects(page.evaluate(() => window.ezTree.setOptions({ accountId: 'other', options: { seed: 1 } })), /只接受/)
  report.checks.push('native tool -> same visible tree -> manual control -> browser automation API -> same Host revision/digest; CAS preserves user seed')
  console.log('Manual, browser API and native tools share project revision 3')
  report.artifacts = []
  for (const format of ['glb', 'png', 'json']) {
    const artifact = await page.evaluate(format => window.ezTree.exportFile({ format, name: `right-browser.${format}` }), format)
    const bytes = await readFile(artifact.path)
    assert.ok(artifact.path.startsWith(join(workspace, 'models/ez-tree')))
    assert.equal(artifact.revision, 3)
    assert.equal(artifact.seed, 24680)
    assert.equal(artifact.optionsDigest, changed.optionsDigest)
    assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'))
    if (format === 'glb') {
      assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
      const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim())
      assert.ok(gltf.meshes.length && gltf.images.length >= 2 && gltf.images.every(image => image.bufferView !== undefined))
      artifact.embeddedImages = gltf.images.length
    } else if (format === 'png') {
      artifact.pixels = await page.evaluate(async base64 => {
        const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
        const data = context.getImageData(0, 0, image.width, image.height).data
        let colored = 0, transparent = 0
        for (let i = 0; i < data.length; i += 4) { if (!data[i + 3]) transparent++; else if (data[i] || data[i + 1] || data[i + 2]) colored++ }
        return { colored, transparent, width: image.width, height: image.height }
      }, bytes.toString('base64'))
      assert.ok(artifact.pixels.colored > 100 && artifact.pixels.transparent > 100)
    } else assert.equal(JSON.parse(bytes.toString('utf8')).seed, 24680)
    report.artifacts.push(artifact)
    console.log(`Direct browser saved ${format}: ${bytes.length} bytes`)
  }
  const beforeReload = await page.evaluate(() => window.ezTree.readProject())
  await page.reload()
  await page.waitForFunction(() => Boolean(window.ezTree?.ready))
  await page.evaluate(() => window.ezTree.ready)
  const restored = await page.evaluate(() => window.ezTree.readProject())
  assert.equal(restored.revision, beforeReload.revision)
  assert.equal(restored.optionsDigest, beforeReload.optionsDigest)
  assert.equal(requests.filter(request => request.path.endsWith('/redeem')).length, 1, 'ordinary reload must use the existing scoped cookie, not replay its ticket')
  assert.ok(requests.filter(request => request.path.endsWith('/upload')).every(request => request.type === 'application/octet-stream' && request.bytes > 100))
  await page.screenshot({ path: join(root, 'right-browser-editor.png') })
  service.revokeAll('integration revoke')
  await assert.rejects(page.evaluate(() => window.ezTree.readProject()), /integration revoke|访问|过期|结束|失效|关闭/)
  await page.waitForFunction(() => document.querySelector('#app canvas').getContext('webgl2').isContextLost())
  assert.equal((await store.read(editor.scope(), agent.id)).project.optionsDigest, restored.optionsDigest)
  report.checks.push('real binary uploads save colored transparent PNG/textured GLB/JSON; cookie-only reload restores; revoked view disposes canvas but retains project')
  assert.deepEqual(errors, [])
  report.requests = requests
  report.passed = true
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, report: join(root, 'report.json'), screenshot: join(root, 'right-browser-editor.png') }))
} catch (error) {
  report.passed = false; report.error = error.stack
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  process.stderr.write(`Direct browser report: ${join(root, 'report.json')}\n`)
  throw error
} finally { await browser.close(); await service.dispose(); await editor.dispose(); store.dispose(); await ctx.fiber.dispose() }
