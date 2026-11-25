import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inventory } from '../scripts/package-desktop.mjs'
import { releaseManifest, releaseFilename } from '../scripts/pack.mjs'

test('release manifest contains only precompiled runtime payload', () => {
  const manifest = releaseManifest({ name: 'test', version: '0.1.0', scripts: { prepare: 'bad' }, dependencies: { foo: '1' }, devDependencies: { bar: '2' }, peerDependencies: { react: '^18' } })
  assert.equal(manifest.scripts, undefined)
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.ok(manifest.files.includes('lib/plugin'))
  assert.ok(manifest.files.includes('lib/editor'))
  assert.ok(manifest.files.includes('resources'))
  assert.ok(manifest.files.includes('docs'))
  assert.ok(manifest.files.includes('licenses'))
  assert.ok(manifest.files.includes('lib/upgrade-profile.mjs'))
  assert.equal(manifest.peerDependenciesMeta.react.optional, true)
})

test('scoped package archive names do not depend on npm8 JSON filename', () => {
  assert.equal(releaseFilename({ name: '@asun-labs/dsh-ez-tree', version: '0.1.0' }), 'asun-labs-dsh-ez-tree-0.1.0.tgz')
  assert.equal(releaseFilename({ name: 'dsh-ez-tree', version: '0.1.1-rc.1' }), 'dsh-ez-tree-0.1.1-rc.1.tgz')
  assert.equal(releaseFilename({ name: 'dsh-ez-tree', version: '0.1.1' }), 'dsh-ez-tree-0.1.1.tgz')
  assert.throws(() => releaseFilename({ name: '../outside', version: '0.1.0' }))
  assert.throws(() => releaseFilename({ name: 'valid', version: '../bad' }))
})

test('inventory hashes actual bytes using portable paths and detects changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ez-tree-inventory-'))
  try {
    await mkdir(join(directory, 'resources'))
    await writeFile(join(directory, 'resources/data'), 'first')
    const [original] = await inventory(directory)
    assert.equal(original.path, 'resources/data')
    assert.equal(original.bytes, 5)
    assert.match(original.sha256, /^[a-f0-9]{64}$/)
    await writeFile(join(directory, 'resources/data'), 'second')
    const [updated] = await inventory(directory)
    assert.notEqual(updated.sha256, original.sha256)
    assert.equal(updated.bytes, 6)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
