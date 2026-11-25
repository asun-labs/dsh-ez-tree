import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { VERSION } from '../version.mjs'
import { parse } from 'yaml'
import { upgradeProfile, migrateManifest, migratePatch, LEGACY_PACKAGE, CANONICAL_PACKAGE } from '../plugin/upgrade-profile.mjs'

function archive(manifest) {
  const value = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(512)
  header.write('package/package.json')
  header.write(value.length.toString(8).padStart(11, '0') + '\0', 124)
  return gzipSync(Buffer.concat([header, value, Buffer.alloc((512 - value.length % 512) % 512), Buffer.alloc(1024)]))
}

async function fixture(t, { selected = true, duplicate = false, failInstall = false, failRollback = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ez-tree-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'), profileDir = join(home, 'profiles/desktop')
  await mkdir(profileDir, { recursive: true })
  const legacy = join(root, 'legacy.tgz')
  const target = join(root, 'new.tgz')
  const newManifest = { name: CANONICAL_PACKAGE, version: VERSION, dsh: { bundle: { patch: './cordis.patch.yml' } } }
  await writeFile(target, archive(newManifest))
  await writeFile(legacy, archive({ name: LEGACY_PACKAGE, version: '0.1.0' }))
  const original = { name: 'test-profile', private: true, description: 'preserve me', dependencies: { other: '1.2.3', [LEGACY_PACKAGE]: `file:${legacy}` },
    dsh: { custom: 'untouched', profile: { other: true, bundles: ['base', ...(selected ? [LEGACY_PACKAGE] : []), 'tail', ...(duplicate ? [CANONICAL_PACKAGE, LEGACY_PACKAGE] : [])] } } }
  const packageFile = join(profileDir, 'package.json')
  const originalPackage = JSON.stringify(original, null, 2) + '\n'
  const patch = `# preserve comment\n- id: dsh-ez-tree\n  name: '${LEGACY_PACKAGE}'\n  disabled: true\n  config:\n    note: '${LEGACY_PACKAGE}'\n- id: other\n  disabled: false\n`
  await writeFile(packageFile, originalPackage)
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# original lock\n')
  await writeFile(join(profileDir, 'cordis.patch.yml'), patch)
  await writeFile(join(home, 'cordis.patch.yml'), `- id: dsh-ez-tree\n  name: '${LEGACY_PACKAGE}'\n  disabled: true\n`)
  const data = join(home, 'ez-tree/accounts/test/exports')
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'tree.json'), '{"seed":123}')
  const locks = new Set(), calls = []
  const operations = {
    async withFileLock(path, callback) { assert.equal(locks.has(path), false, 'must not nest installer package lock'); locks.add(path); try { return await callback() } finally { locks.delete(path) } },
    async writeFileAtomic(path, value) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) },
    async install(args) {
      assert.equal(locks.has(packageFile), false)
      calls.push(args)
      if (args[0] === 'add') {
        if (failInstall) throw new Error('simulated install failure')
        const current = JSON.parse(await readFile(packageFile))
        assert.equal(current.dependencies[LEGACY_PACKAGE], undefined)
        assert.equal(current.dsh.profile.bundles.includes(LEGACY_PACKAGE), false)
        assert.equal(current.dsh.profile.bundles.includes(CANONICAL_PACKAGE), false)
        current.dependencies[CANONICAL_PACKAGE] = `file:${target}`
        current.dsh.profile.bundles.push(CANONICAL_PACKAGE)
        await writeFile(packageFile, JSON.stringify(current))
        const installed = join(profileDir, 'node_modules', CANONICAL_PACKAGE)
        await mkdir(installed, { recursive: true }); await writeFile(join(installed, 'package.json'), JSON.stringify(newManifest))
        await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# new lock\n')
      } else if (args.includes('--offline') && failRollback) throw new Error('simulated rollback failure')
    },
  }
  return { home, profileDir, target, packageFile, originalPackage, original, patch, data, calls, operations,
    options: { home, profile: 'desktop', archive: target, cli: join(root, 'official-bin.js'), hostStopped: true, operations } }
}

test('manifest migration replaces old name at original position and deduplicates only this product', () => {
  const input = { dependencies: { [LEGACY_PACKAGE]: 'old', unrelated: 'keep' }, dsh: { profile: { bundles: ['base', LEGACY_PACKAGE, 'tail', CANONICAL_PACKAGE, 'tail'] } } }
  const result = migrateManifest(input)
  assert.deepEqual(result.dsh.profile.bundles, ['base', CANONICAL_PACKAGE, 'tail', 'tail'])
  assert.deepEqual(result.dependencies, { unrelated: 'keep' })
  assert.equal(input.dependencies[LEGACY_PACKAGE], 'old')
})

test('YAML migration preserves disabled/config/comments/!!js and leaves ordinary user strings unchanged', () => {
  const input = `# original header\n- id: dsh-ez-tree\n  name: '${LEGACY_PACKAGE}'\n  disabled: !!js 'ctx.get("setting") === false'\n  config:\n    note: '${LEGACY_PACKAGE}'\n- id: unrelated\n  config:\n    name: '${LEGACY_PACKAGE}'\n`
  const result = migratePatch(input)
  assert.equal(result.changed, true)
  assert.match(result.text, /# original header/)
  assert.match(result.text, /!!js/)
  assert.equal(result.text.split(LEGACY_PACKAGE).length - 1, 2)
  assert.equal(migratePatch(result.text).changed, false)
  assert.throws(() => migratePatch('- id: custom\n  name: "@asun-labs/dsh-ez-tree"\n'), /自定义/)
})

test('duplicate standalone insert becomes an override without changing subsequent override precedence', () => {
  const input = `- insert:\n    - id: dsh-ez-tree\n      name: '${LEGACY_PACKAGE}'\n      disabled: true\n      config: {quality: low}\n- id: dsh-ez-tree\n  disabled: false\n`
  const output = parse(migratePatch(input).text)
  assert.deepEqual(output[0].insert, [])
  assert.equal(output[1].name, CANONICAL_PACKAGE)
  assert.equal(output[1].disabled, true)
  assert.equal(output[2].disabled, false)
  assert.equal(migratePatch(input, { selected: false }).text.includes('insert:'), true)
})

test('upgrade preserves unrelated state, entry disabled overrides, bundle order and app data; repeat is no-op', async t => {
  const f = await fixture(t, { duplicate: true })
  const result = await upgradeProfile(f.options)
  assert.equal(result.changed, true)
  const manifest = JSON.parse(await readFile(f.packageFile))
  assert.equal(manifest.dependencies[LEGACY_PACKAGE], undefined)
  assert.equal(manifest.dependencies.other, '1.2.3')
  assert.deepEqual(manifest.dsh.profile.bundles, ['base', CANONICAL_PACKAGE, 'tail'])
  assert.equal(manifest.dsh.custom, 'untouched')
  const patch = parse(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8'))
  assert.equal(patch[0].name, CANONICAL_PACKAGE)
  assert.equal(patch[0].disabled, true)
  assert.equal(patch[0].config.note, LEGACY_PACKAGE)
  assert.equal(await readFile(join(f.data, 'tree.json'), 'utf8'), '{"seed":123}')
  assert.equal((await readFile(join(result.backup, 'manifest.json'), 'utf8')).includes('legacy-source.tgz'), true)
  const calls = f.calls.length
  assert.equal((await upgradeProfile(f.options)).changed, false)
  assert.equal(f.calls.length, calls)
})

test('an intentionally deselected old bundle remains deselected after official installer autoactivation', async t => {
  const f = await fixture(t, { selected: false })
  const result = await upgradeProfile(f.options)
  assert.equal(result.selected, false)
  assert.deepEqual(JSON.parse(await readFile(f.packageFile)).dsh.profile.bundles, ['base', 'tail'])
})

test('failed upgrade restores byte-exact configuration and invokes official offline rollback', async t => {
  const f = await fixture(t, { failInstall: true })
  await assert.rejects(upgradeProfile(f.options), /原配置和依赖已恢复/)
  assert.equal(await readFile(f.packageFile, 'utf8'), f.originalPackage)
  assert.equal(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8'), f.patch)
  assert.equal(await readFile(join(f.profileDir, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9.0\n# original lock\n')
  assert.equal(f.calls.at(-1).includes('--offline'), true)
})

test('failed rollback leaves saved configuration and reports retained recovery backup', async t => {
  const f = await fixture(t, { failInstall: true, failRollback: true })
  await assert.rejects(upgradeProfile(f.options), /恢复依赖失败.*备份保留在/s)
  assert.equal(await readFile(f.packageFile, 'utf8'), f.originalPackage)
})

test('explicit stopped-host acknowledgment and exact canonical artifact identity are mandatory', async t => {
  const f = await fixture(t)
  await assert.rejects(upgradeProfile({ ...f.options, hostStopped: false }), /彻底退出/)
  await writeFile(f.target, archive({ name: LEGACY_PACKAGE, version: VERSION, dsh: { bundle: {} } }))
  await assert.rejects(upgradeProfile(f.options), new RegExp('只接受 dsh-ez-tree@'+VERSION.replaceAll('.', '\\.')))
  assert.equal(await readFile(f.packageFile, 'utf8'), f.originalPackage)
})
