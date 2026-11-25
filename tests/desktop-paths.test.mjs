import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { dataDirectory, outputName, saveExport, saveChosenExport } from '../desktop/paths.mjs'

test('account data respects explicit DSH home and isolates accounts', () => {
  const home = join(tmpdir(), 'ez-tree-home')
  assert.equal(dataDirectory({ home, account: 'alice' }), join(home, 'ez-tree', 'accounts', createHash('sha256').update('alice').digest('hex').slice(0, 16)))
  assert.notEqual(dataDirectory({ home, account: 'alice' }), dataDirectory({ home, account: 'bob' }))
})

test('exports refuse traversal, Windows reserved devices, and conflicting extensions', () => {
  for (const name of ['../escape', 'C:\\escape', 'tree/escape', 'tree..glb', 'CON', 'nul.glb', 'LPT1', '.hidden', 'tree.png']) {
    assert.throws(() => outputName('glb', name), undefined, name)
  }
  assert.equal(outputName('glb', 'oak-123'), 'oak-123.glb')
  assert.equal(outputName('glb', 'oak-123.glb'), 'oak-123.glb')
})

test('atomic export never overwrites an existing result, including concurrent writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ez-tree-export-'))
  try {
    const first = Buffer.from('first export')
    const result = await saveExport(directory, 'json', 'project', first.toString('base64'))
    assert.equal(result.sha256, createHash('sha256').update(first).digest('hex'))
    await assert.rejects(saveExport(directory, 'json', 'project', Buffer.from('replacement').toString('base64')), { code: 'EEXIST' })
    assert.deepEqual(await readFile(result.path), first)
    const writes = await Promise.allSettled([saveExport(directory, 'png', 'race', 'YQ=='), saveExport(directory, 'png', 'race', 'Yg==')])
    assert.equal(writes.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(writes.find(value => value.status === 'rejected').reason.code, 'EEXIST')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native save dialog permits Unicode names and explicitly chosen replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ez-tree-native-save-'))
  try {
    const destination = join(directory, '树木项目.json')
    await saveChosenExport(destination, 'json', Buffer.from('{"seed":1}').toString('base64'))
    await saveChosenExport(destination, 'json', Buffer.from('{"seed":2}').toString('base64'))
    assert.equal(JSON.parse(await readFile(destination, 'utf8')).seed, 2)
    await assert.rejects(saveChosenExport(destination, 'glb', 'YQ=='), /扩展名/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
