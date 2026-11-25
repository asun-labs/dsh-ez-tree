import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { mergeOptions, checkComplexity } from '../app/options.js'

const presetsDirectory = new URL('../vendor/ez-tree/src/lib/presets/', import.meta.url)
const presets = await Promise.all((await readdir(presetsDirectory)).filter(name => name.endsWith('.json')).map(async name => [name, JSON.parse(await readFile(new URL(name, presetsDirectory)))]))
const options = presets.find(([name]) => name === 'ash_medium.json')[1]

test('all upstream presets are accepted without changing their parameters', () => {
  for (const [name, value] of presets) {
    assert.deepEqual(mergeOptions(value, value), value, name)
    assert.doesNotThrow(() => checkComplexity(value), name)
  }
})

test('partial edits preserve the other fields and leave input untouched', () => {
  const updated = mergeOptions(options, { seed: 42, branch: { length: { 0: 15 } } })
  assert.equal(updated.seed, 42)
  assert.equal(updated.branch.length[0], 15)
  assert.equal(updated.branch.length[1], options.branch.length[1])
  assert.notEqual(options.seed, 42)
  assert.notEqual(updated.branch, options.branch)
})

test('invalid input is rejected before entering tree generation', () => {
  for (const patch of [{ seed: NaN }, { seed: -1 }, { branch: { levels: 4 } }, { leaves: { type: 'missing' } }, { bark: null }, { unknown: 1 }, { seed: 1.5 }, JSON.parse('{"__proto__":{"polluted":true}}')]) assert.throws(() => mergeOptions(options, patch))
  assert.equal({}.polluted, undefined)
})

test('excessive combinatorial generation is rejected', () => {
  const heavy = mergeOptions(options, { branch: { children: { 0: 100, 1: 10, 2: 5 } }, leaves: { count: 100 } })
  assert.throws(() => checkComplexity(heavy), /复杂度/)
})
