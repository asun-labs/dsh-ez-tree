import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { optionsSchema, mergeOptions, validateComplexity } from '../mcp/options.mjs'

test('every bundled preset passes input validation and generation budget', async () => {
  const directory = new URL('../vendor/ez-tree/src/lib/presets/', import.meta.url)
  const files = (await readdir(directory)).filter(file => file.endsWith('.json'))
  assert.equal(files.length, 15)
  for (const file of files) {
    const options = JSON.parse(await readFile(new URL(file, directory), 'utf8'))
    assert.doesNotThrow(() => optionsSchema.parse(options), file)
    assert.doesNotThrow(() => validateComplexity(options), file)
  }
})

test('nested patches retain all unaffected parameters without changing the source', async () => {
  const source = JSON.parse(await readFile(new URL('../vendor/ez-tree/src/lib/presets/ash_small.json', import.meta.url), 'utf8'))
  const merged = mergeOptions(source, optionsSchema.parse({ seed: 123, branch: { children: { 0: 5 } } }))
  assert.equal(merged.seed, 123)
  assert.equal(merged.branch.children[0], 5)
  assert.equal(merged.branch.children[1], source.branch.children[1])
  assert.notEqual(source.seed, 123)
})

test('invalid structure and excessive combined complexity fail before renderer generation', async () => {
  for (const patch of [{ seed: NaN }, { type: 'unknown' }, { branch: { levels: 99 } }, { branch: { children: { 0: 999 } } }, { renderer: { execute: 'code' } }]) {
    assert.equal(optionsSchema.safeParse(patch).success, false)
  }
  const source = JSON.parse(await readFile(new URL('../vendor/ez-tree/src/lib/presets/ash_small.json', import.meta.url), 'utf8'))
  const excessive = mergeOptions(source, { branch: { levels: 3, children: { 0: 100, 1: 10, 2: 5 } }, leaves: { count: 100 } })
  assert.throws(() => validateComplexity(excessive), /200 万/)
})
