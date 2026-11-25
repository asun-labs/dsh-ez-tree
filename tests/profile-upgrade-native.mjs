import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { VERSION } from '../version.mjs'

// 独立 Home 中调用真正官方安装器与 TGZ 内的迁移程序，不修改用户 Profile。
const arg = name => process.argv[process.argv.indexOf(name) + 1]
if (process.argv.includes('--help')) {
  console.log('验证真实官方 CLI 下的旧名称升级及重复执行。\n示例：node tests/profile-upgrade-native.mjs --cli C:/DSH/lib/bin.js --package ./dist/dsh-ez-tree-0.1.2.tgz --legacy ./dist/asun-labs-dsh-ez-tree-0.1.0.tgz')
  process.exit(0)
}
for (const name of ['--cli', '--package', '--legacy']) assert.ok(process.argv.includes(name), `缺少 ${name}，请先查看 --help。`)
const cli = resolve(arg('--cli')), archive = resolve(arg('--package')), legacy = resolve(arg('--legacy'))
const root = resolve(import.meta.dirname, '..'), run = promisify(execFile)
const base = join(root, '.build/profile-upgrade')
await mkdir(base, { recursive: true })
const output = await mkdtemp(join(base, 'run-')), home = join(output, 'home'), extracted = join(output, 'artifact')
await mkdir(extracted)
await run('tar', ['-xf', archive, '-C', extracted], { windowsHide: true })
const packageRoot = join(extracted, 'package')
const installed = JSON.parse(await readFile(join(packageRoot, 'package.json')))
assert.equal(installed.name, 'dsh-ez-tree')
assert.equal(installed.version, VERSION)
const { upgradeProfile } = await import(pathToFileURL(join(packageRoot, 'lib/upgrade-profile.mjs')).href)
const official = 'const cli=process.argv[1];const args=JSON.parse(process.argv[2]);const {runCli}=await import(cli);process.argv=[process.execPath,cli,...args];await runCli({manageDesktopProfile:true});'
async function invoke(args) {
  const value = await run(process.execPath, ['--input-type=module', '--eval', official, pathToFileURL(cli).href, JSON.stringify(args)],
    { cwd: dirname(cli), windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, DSH_HOME: home } })
  return value.stdout
}
const steps = {}
for (const profile of ['desktop', 'web']) {
  const initial = join(home, 'profiles', profile)
  await mkdir(initial, { recursive: true })
  await writeFile(join(initial, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}`, private: true,
    dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n')
  await invoke(['plugin', '--profile', profile, 'add', legacy, '--ignore-scripts'])
  const directory = join(home, 'profiles', profile), manifestPath = join(directory, 'package.json')
  const before = JSON.parse(await readFile(manifestPath))
  assert.ok(before.dsh.profile.bundles.includes('@asun-labs/dsh-ez-tree'))
  before.userSentinel = { keep: true }
  await writeFile(manifestPath, JSON.stringify(before, null, 2) + '\n')
  const disabled = profile === 'desktop'
  await writeFile(join(directory, 'cordis.patch.yml'), `# keep user comment\n- id: dsh-ez-tree\n  name: "@asun-labs/dsh-ez-tree"\n  disabled: ${disabled}\n  config:\n    note: "@asun-labs/dsh-ez-tree"\n`)
  const result = await upgradeProfile({ home, profile, archive, cli, hostStopped: true })
  assert.equal(result.changed, true)
  const after = JSON.parse(await readFile(manifestPath))
  assert.deepEqual(after.userSentinel, before.userSentinel)
  assert.deepEqual(after.dsh.profile.bundles, before.dsh.profile.bundles.map(name => name === '@asun-labs/dsh-ez-tree' ? 'dsh-ez-tree' : name))
  assert.equal(after.dependencies['@asun-labs/dsh-ez-tree'], undefined)
  const canonical = JSON.parse(await readFile(join(directory, 'node_modules/dsh-ez-tree/package.json')))
  assert.equal(canonical.version, VERSION)
  await assert.rejects(access(join(directory, 'node_modules/@asun-labs/dsh-ez-tree')), { code: 'ENOENT' })
  const patch = await readFile(join(directory, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /# keep user comment/)
  assert.ok(patch.includes(`disabled: ${disabled}`))
  assert.ok(patch.includes('note: "@asun-labs/dsh-ez-tree"'))
  assert.match(patch, /name: "dsh-ez-tree"/)
  const repeat = await upgradeProfile({ home, profile, archive, cli, hostStopped: true })
  assert.equal(repeat.changed, false)
  steps[profile] = { migration: 'passed', physicalLegacyRemoved: true, bundleOrder: 'preserved', disabled, compiledEntry: true, idempotent: true, backup: result.backup }
}
const bytes = await readFile(archive)
const report = { package: 'dsh-ez-tree@' + VERSION, sha256: createHash('sha256').update(bytes).digest('hex'), artifact: archive, output, steps }
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(join(root, '.build/profile-upgrade-verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
