import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { isMap, isSeq, parseDocument } from 'yaml'
import { VERSION } from '../version.mjs'

export const LEGACY_PACKAGE = '@asun-labs/dsh-ez-tree'
export const CANONICAL_PACKAGE = 'dsh-ez-tree'
const ENTRY_ID = 'dsh-ez-tree'
const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml', 'compatibility.json']
const exec = promisify(execFile)

export function migrateManifest(input, { selected } = {}) {
  const output = structuredClone(input)
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) if (output[kind]) delete output[kind][LEGACY_PACKAGE]
  const previous = input.dsh?.profile?.bundles ?? []
  const enabled = selected ?? previous.some(value => value === LEGACY_PACKAGE || value === CANONICAL_PACKAGE)
  const bundles = []
  let added = false
  for (const value of previous) {
    if (value === LEGACY_PACKAGE || value === CANONICAL_PACKAGE) {
      if (enabled && !added) { bundles.push(CANONICAL_PACKAGE); added = true }
    } else bundles.push(value)
  }
  if (enabled && !added) bundles.push(CANONICAL_PACKAGE)
  output.dsh = { ...output.dsh, profile: { ...output.dsh?.profile, bundles } }
  return output
}

/** 只遍历 Loader 的 patch/insert/group 结构；普通业务 config 中的同名文本不变。 */
export function migratePatch(text, { selected = true } = {}) {
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (document.errors.length) throw new Error(`无法解析 Cordis 配置：${document.errors[0].message}`)
  if (!isSeq(document.contents)) throw new Error('Cordis 配置必须是 YAML 数组。')
  let changed = false
  const overrides = new Map()
  function walk(list, inserted = false, grouped = false, owner) {
    for (let index = 0; index < list.items.length; index++) {
      const node = list.items[index]
      if (!isMap(node)) continue
      const parent = owner ?? node
      const id = node.get('id'), name = node.get('name')
      if (name === LEGACY_PACKAGE || name === CANONICAL_PACKAGE) {
        if (id !== ENTRY_ID) throw new Error('发现自定义 EZ-Tree entry id，请先人工核对，升级未写入任何配置。')
        if (grouped && selected) throw new Error('发现分组中的独立 EZ-Tree entry，请先人工合并，避免升级后重复 entry。')
        if (inserted && selected) {
          node.set('name', CANONICAL_PACKAGE)
          list.items.splice(index--, 1)
          if (!overrides.has(parent)) overrides.set(parent, [])
          overrides.get(parent).push(node)
          changed = true
          continue
        }
        if (name === LEGACY_PACKAGE) { node.set('name', CANONICAL_PACKAGE); changed = true }
      } else if (id === ENTRY_ID && name) throw new Error('dsh-ez-tree entry id 已被其他模块占用。')
      const insert = node.get('insert', true)
      if (isSeq(insert)) walk(insert, true, false, parent)
      const config = node.get('config', true)
      if (node.get('group') === true && isSeq(config)) walk(config, inserted, true, parent)
    }
  }
  walk(document.contents)
  document.contents.items = document.contents.items.flatMap(node => [node, ...(overrides.get(node) ?? [])])
  return { text: changed ? String(document) : text, changed }
}

export function archiveManifest(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })
  for (let position = 0; position + 512 <= tar.length;) {
    const header = tar.subarray(position, position + 512)
    const string = (offset, size) => header.subarray(offset, offset + size).toString('utf8').replace(/\0.*$/s, '')
    const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/')
    const size = Number.parseInt(string(124, 12).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0 || position + 512 + size > tar.length) throw new Error('插件 tgz 文件结构无效。')
    if (name === 'package/package.json') return JSON.parse(tar.subarray(position + 512, position + 512 + size).toString('utf8'))
    position += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('插件 tgz 缺少 package/package.json。')
}

async function officialOperations(cli, home, profile) {
  const require = createRequire(cli)
  const atomic = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
  const program = `const cli=process.argv[1];const args=JSON.parse(process.argv[2]);const {runCli}=await import(cli);process.argv=[process.execPath,cli,...args];await runCli({manageDesktopProfile:true});`
  return { ...atomic, async install(args) {
    try {
      return await exec(process.execPath, ['--input-type=module', '--eval', program, pathToFileURL(cli).href, JSON.stringify(['plugin', '--profile', profile, ...args])],
        { cwd: dirname(cli), env: { ...process.env, DSH_HOME: home }, windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
    } catch (error) { throw new Error(`官方插件安装器失败（${error.code ?? 'unknown'}）：${error.stderr || error.stdout || error.message}`) }
  } }
}

async function snapshotFiles(paths) {
  return Promise.all(paths.map(async path => {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`配置必须是普通文件：${path}`)
      return { path, bytes: await readFile(path), mode: stat.mode & 0o777 }
    } catch (error) { if (error.code === 'ENOENT') return { path }; throw error }
  }))
}

async function restoreFiles(records, operations) {
  for (const record of records) {
    if (record.bytes === undefined) await rm(record.path, { force: true })
    else await operations.writeFileAtomic(record.path, record.bytes, { mode: record.mode || 0o600 })
  }
}

export async function upgradeProfile({ home, profile = 'desktop', archive, cli, hostStopped = false, expectedVersion = VERSION, operations } = {}) {
  if (!home || !cli || !archive) throw new Error('必须明确提供 --home、--cli 和 --package。')
  if (!hostStopped) throw new Error('请先彻底退出该 Home 的 DSH/Seal Host，再传入 --host-stopped；不要同时运行其他插件管理命令。')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) throw new Error('Profile 名称无效。')
  const absoluteHome = resolve(home), absoluteCli = resolve(cli), artifact = resolve(archive)
  const profileDir = join(absoluteHome, 'profiles', profile)
  const bytes = await readFile(artifact)
  const wanted = archiveManifest(bytes)
  if (wanted.name !== CANONICAL_PACKAGE || wanted.version !== expectedVersion || !wanted.dsh?.bundle) throw new Error(`只接受 ${CANONICAL_PACKAGE}@${expectedVersion} 正式插件包。`)
  const tools = operations ?? await officialOperations(absoluteCli, absoluteHome, profile)
  const packageFile = join(profileDir, 'package.json')
  await lstat(packageFile)
  return tools.withFileLock(join(profileDir, '.ez-tree-upgrade'), async () => {
    const originalText = await readFile(packageFile, 'utf8')
    const original = JSON.parse(originalText)
    const bundles = original.dsh?.profile?.bundles ?? []
    const selected = bundles.includes(LEGACY_PACKAGE) || bundles.includes(CANONICAL_PACKAGE)
    const migrated = migrateManifest(original, { selected })
    const paths = [...PROFILE_FILES.map(file => join(profileDir, file)), join(absoluteHome, 'cordis.patch.yml')]
    const records = await snapshotFiles(paths)
    const patches = records.filter(record => record.bytes !== undefined && (record.path.endsWith('cordis.patch.yml') || record.path.endsWith('cordis.yml')))
      .map(record => ({ ...record, migrated: migratePatch(record.bytes.toString('utf8'), { selected }) }))
    const installedPath = join(profileDir, 'node_modules', CANONICAL_PACKAGE, 'package.json')
    let installed
    try { installed = JSON.parse(await readFile(installedPath)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const legacyDependency = ['dependencies', 'devDependencies', 'optionalDependencies'].some(kind => original[kind]?.[LEGACY_PACKAGE])
    const canonicalDependency = ['dependencies', 'devDependencies', 'optionalDependencies'].some(kind => original[kind]?.[CANONICAL_PACKAGE])
    if (!legacyDependency && !canonicalDependency && !bundles.includes(LEGACY_PACKAGE) && !bundles.includes(CANONICAL_PACKAGE)) throw new Error('此 Profile 没有安装 EZ-Tree，不需要执行迁移。')
    const canonicalCount = bundles.filter(value => value === CANONICAL_PACKAGE).length
    if (!legacyDependency && canonicalDependency && !bundles.includes(LEGACY_PACKAGE) && canonicalCount <= 1 && installed?.name === CANONICAL_PACKAGE && installed?.version === expectedVersion && !patches.some(patch => patch.migrated.changed))
      return { changed: false, package: `${CANONICAL_PACKAGE}@${expectedVersion}`, profileDir, selected }
    const backup = join(profileDir, '.ez-tree-upgrades', `${Date.now()}-${randomUUID()}`)
    await mkdir(backup, { recursive: true, mode: 0o700 })
    for (const [index, record] of records.entries()) if (record.bytes !== undefined) await writeFile(join(backup, `${index}.original`), record.bytes, { mode: 0o600, flag: 'wx' })
    const source = original.dependencies?.[LEGACY_PACKAGE] ?? original.devDependencies?.[LEGACY_PACKAGE] ?? original.optionalDependencies?.[LEGACY_PACKAGE]
    let sourceBackup
    if (typeof source === 'string' && source.startsWith('file:')) {
      const raw = source.slice(5)
      const path = raw.startsWith('//') ? fileURLToPath(source) : isAbsolute(raw) ? raw : resolve(profileDir, raw)
      try { if ((await lstat(path)).isFile()) { sourceBackup = join(backup, 'legacy-source.tgz'); await copyFile(path, sourceBackup) } }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({ schemaVersion: 1, profileDir, originalSource: source, sourceBackup,
      target: `${CANONICAL_PACKAGE}@${expectedVersion}`, artifact, sha256: createHash('sha256').update(bytes).digest('hex'),
      files: records.map((record, index) => ({ path: record.path, present: record.bytes !== undefined, backup: `${index}.original`, mode: record.mode })) }, null, 2), { mode: 0o600, flag: 'wx' })
    let mutated = false
    try {
      await tools.withFileLock(packageFile, async () => {
        if (await readFile(packageFile, 'utf8') !== originalText) throw new Error('Profile 在升级准备期间已被修改，请重试。')
        // 新包安装前清除旧 bundle，整个迁移期间都不组合两个同 id 的插件。
        const staging = migrateManifest(original, { selected: false })
        await tools.writeFileAtomic(packageFile, JSON.stringify(staging, null, 2) + '\n', { mode: 0o600 })
        mutated = true
        for (const patch of patches) if (patch.migrated.changed) await tools.writeFileAtomic(patch.path, patch.migrated.text, { mode: patch.mode || 0o600 })
      })
      await tools.install(['add', artifact, '--ignore-scripts'])
      await tools.withFileLock(packageFile, async () => {
        const current = JSON.parse(await readFile(packageFile))
        const final = migrateManifest(current, { selected: false })
        final.dsh.profile.bundles = migrated.dsh.profile.bundles
        await tools.writeFileAtomic(packageFile, JSON.stringify(final, null, 2) + '\n', { mode: 0o600 })
      })
      const actual = JSON.parse(await readFile(installedPath))
      if (actual.name !== CANONICAL_PACKAGE || actual.version !== expectedVersion) throw new Error('安装后的插件身份或版本不匹配。')
      if (legacyDependency) {
        // add 不负责 prune 未声明的包；官方 install 以当前 manifest 清理旧依赖。
        await tools.install(['install', '--ignore-scripts', '--frozen-lockfile'])
      }
      return { changed: true, package: `${actual.name}@${actual.version}`, profileDir, selected, backup,
        sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch (error) {
      if (!mutated) throw error
      let rollback
      try {
        await tools.withFileLock(packageFile, () => restoreFiles(records, tools))
        await tools.install(['install', '--ignore-scripts', '--frozen-lockfile', '--offline'])
        await tools.withFileLock(packageFile, () => restoreFiles(records, tools))
        rollback = '原配置和依赖已恢复'
      } catch (failure) { rollback = `恢复依赖失败：${failure.message}` }
      throw new Error(`EZ-Tree 升级失败：${error.message}；${rollback}。备份保留在 ${backup}`)
    }
  }, { waitMs: 120000 })
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('将旧 scoped EZ-Tree 安全迁移为 dsh-ez-tree，保留 Profile 启停与配置。\n用法：node lib/upgrade-profile.mjs --home <DSH_HOME> --profile desktop --cli <官方DSH/lib/bin.js> --package <dsh-ez-tree-0.1.1.tgz> --host-stopped\n示例：node lib/upgrade-profile.mjs --home C:/Users/me/.seal-harness --profile desktop --cli C:/DSH/node_modules/@deepseek-ai/dsh/lib/bin.js --package ./dsh-ez-tree-0.1.1.tgz --host-stopped')
    return
  }
  const value = key => { const index = argv.indexOf(key); return index < 0 ? undefined : argv[index + 1] }
  const result = await upgradeProfile({ home: value('--home'), profile: value('--profile') ?? 'desktop', archive: value('--package'), cli: value('--cli'), hostStopped: argv.includes('--host-stopped') })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
