import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { VERSION } from '../version.mjs'

const executable = process.env.EZ_TREE_EXECUTABLE
const appEntry = process.env.EZ_TREE_APP_ENTRY
const mcpEntry = process.env.EZ_TREE_MCP_ENTRY
const enabled = Boolean(executable)

test('packaged application serves actual MCP stdio and exports a textured tree', { skip: !enabled, timeout: 180_000 }, async () => {
  assert.ok(existsSync(executable), 'EZ_TREE_EXECUTABLE must refer to a packaged executable')
  const directory = await mkdtemp(join(tmpdir(), 'ez-tree-mcp-real-'))
  const output = join(directory, 'outputs')
  const environment = { ...process.env, DSH_HOME: join(directory, 'home') }
  delete environment.ELECTRON_RUN_AS_NODE
  if (mcpEntry) environment.ELECTRON_RUN_AS_NODE = '1'
  const transport = new StdioClientTransport({ command: resolve(executable),
    args: mcpEntry ? [mcpEntry, ...(appEntry ? ['--app-entry', appEntry] : []), '--account', 'stdio-test', '--output-dir', output]
      : [...(appEntry ? [appEntry] : []), '--mcp', '--account', 'stdio-test', '--output-dir', output], env: environment, stderr: 'pipe' })
  let diagnostics = ''
  let phase = 'connect'
  transport.stderr?.on('data', bytes => { diagnostics += bytes.toString() })
  const client = new Client({ name: 'dsh-ez-tree-verifier', version: VERSION })
  client.onerror = error => { diagnostics += `\nMCP client error: ${error.stack ?? error.message}\n` }
  const value = async (name, args = {}) => {
    phase = name
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    assert.notEqual(result.isError, true, `${JSON.stringify(result)}\n${diagnostics}`)
    return JSON.parse(result.content.find(block => block.type === 'text').text)
  }
  try {
    await client.connect(transport, { timeout: 120_000 })
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['ez_tree_export', 'ez_tree_generate', 'ez_tree_get_parameters', 'ez_tree_list_presets'])
    const { presets } = await value('ez_tree_list_presets')
    assert.equal(presets.length, 15)
    const generated = await value('ez_tree_generate', { preset: 'Ash Small', options: { seed: 24680 } })
    assert.ok(generated.vertexCount > 100)
    assert.ok(generated.triangleCount > 100)
    const parameters = await value('ez_tree_get_parameters')
    assert.equal(parameters.options.seed, 24680)
    const project = await value('ez_tree_export', { format: 'json', name: 'project' })
    assert.equal(JSON.parse(await readFile(project.path, 'utf8')).seed, 24680)
    const model = await value('ez_tree_export', { format: 'glb', name: 'model' })
    const bytes = await readFile(model.path)
    assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
    assert.equal(bytes.readUInt32LE(4), 2)
    assert.equal(bytes.readUInt32LE(8), bytes.length)
    const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim())
    assert.ok(gltf.meshes.length > 0)
    assert.ok(gltf.images?.length > 0, 'textured GLB includes its images')
    const preview = await value('ez_tree_export', { format: 'png', name: 'preview' })
    const png = await readFile(preview.path)
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const invalid = await client.callTool({ name: 'ez_tree_export', arguments: { format: 'glb', name: '../escape' } })
    assert.equal(invalid.isError, true)
    const overwrite = await client.callTool({ name: 'ez_tree_export', arguments: { format: 'json', name: 'project' } })
    assert.equal(overwrite.isError, true)
  } catch (error) {
    error.message += `\nMCP phase: ${phase}\nMCP application stderr:\n${diagnostics}`
    throw error
  } finally {
    await client.close()
    await transport.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('full hidden GUI and MCP can use one account concurrently', { skip: !enabled || !mcpEntry, timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ez-tree-concurrent-'))
  const readyFile = join(directory, 'gui-ready.json')
  const environment = { ...process.env, DSH_HOME: join(directory, 'home') }
  delete environment.ELECTRON_RUN_AS_NODE
  const gui = spawn(resolve(executable), [...(appEntry ? [appEntry] : []), '--no-window', '--account', 'concurrent-test', '--ready-file', readyFile],
    { env: environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let diagnostics = ''
  gui.stderr.on('data', bytes => { diagnostics += bytes.toString() })
  const transport = new StdioClientTransport({ command: resolve(executable),
    args: [mcpEntry, ...(appEntry ? ['--app-entry', appEntry] : []), '--account', 'concurrent-test'],
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' })
  transport.stderr?.on('data', bytes => { diagnostics += bytes.toString() })
  const client = new Client({ name: 'dsh-ez-tree-concurrency', version: VERSION })
  try {
    const deadline = Date.now() + 90_000
    while (!existsSync(readyFile)) {
      assert.equal(gui.exitCode, null, diagnostics)
      assert.ok(Date.now() < deadline, `GUI readiness timeout\n${diagnostics}`)
      await delay(50)
    }
    const guiReady = JSON.parse(await readFile(readyFile, 'utf8'))
    await client.connect(transport, { timeout: 120_000 })
    const parameters = await client.callTool({ name: 'ez_tree_get_parameters', arguments: {} })
    assert.notEqual(parameters.isError, true)
    const value = JSON.parse(parameters.content[0].text)
    assert.equal(value.outputDirectory, guiReady.outputDirectory)
    const generated = await client.callTool({ name: 'ez_tree_generate', arguments: { preset: 'Pine Small', options: { seed: 97531 } } })
    assert.notEqual(generated.isError, true, JSON.stringify(generated))
    const exported = await client.callTool({ name: 'ez_tree_export', arguments: { format: 'json', name: 'concurrent-project' } })
    assert.notEqual(exported.isError, true)
    const result = JSON.parse(exported.content[0].text)
    assert.equal(JSON.parse(await readFile(result.path, 'utf8')).seed, 97531)
    assert.equal(gui.exitCode, null, 'MCP must not close or replace the GUI process')
    assert.doesNotMatch(diagnostics, /Unable to create cache|Unable to move the cache|Gpu Cache Creation failed/, diagnostics)
  } catch (error) {
    error.message += `\nConcurrent application stderr:\n${diagnostics}`
    throw error
  } finally {
    await client.close()
    await transport.close()
    if (gui.exitCode === null) {
      const exited = new Promise(resolve => gui.once('exit', resolve))
      gui.kill()
      await exited
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
