import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'

test('compiled native client registers the exact npm identity and exports executable plugin code', async () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root)))
  assert.equal(manifest.name, 'dsh-ez-tree')
  const code = await readFile(new URL('lib/plugin/client.js', root), 'utf8')
  const require = createRequire(import.meta.url)
  let registration
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load(value) { registration = value } } } }, { timeout: 1000 })
  assert.equal(registration.id, manifest.name)
  assert.notEqual(registration.id, '@asun-labs/dsh-ez-tree')
  const plugin = registration.factory(require)
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.inject.includes('sidebarRight'))
  assert.ok(plugin.inject.includes('connection'))
})
