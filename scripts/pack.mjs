import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { buildAll, root } from './build.mjs'

const runtimePaths = ['lib/plugin', 'skills', 'releases', 'docs', 'licenses', 'cordis.patch.yml', 'README.md', 'LICENSE', 'NOTICE', 'vendor/ez-tree/LICENSE', 'vendor/ez-tree/provenance.json']
export function releaseManifest(manifest) {
  const { scripts, devDependencies, dependencies, ...runtime } = manifest
  return { ...runtime, files: runtimePaths, peerDependenciesMeta: { react: { optional: true } } }
}

export function releaseFilename(manifest) {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(manifest.name) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('发布包名称或版本无效。')
  return `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
}

function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH || '').split(delimiter).map(directory => join(directory, 'node_modules/npm/bin/npm-cli.js'))]
  const selected = candidates.find(path => path?.endsWith('npm-cli.js') && existsSync(path))
  if (!selected) throw new Error('找不到 npm CLI，请通过 npm run pack:release 运行。')
  return selected
}

export async function packRelease({ skipBuild = false } = {}) {
  if (!skipBuild) await buildAll()
  const stage = await mkdtemp(join(tmpdir(), 'dsh-ez-tree-release-'))
  try {
    const manifest = releaseManifest(JSON.parse(await readFile(join(root, 'package.json'))))
    const trusted = JSON.parse(await readFile(join(root, 'releases/runtime.json')))
    if (trusted.version !== manifest.version || !Object.keys(trusted.platforms).length) throw new Error('必须先完成独立桌面包验收，才能发布插件。')
    for (const path of runtimePaths) {
      await mkdir(dirname(join(stage, path)), { recursive: true })
      await cp(join(root, path), join(stage, path), { recursive: true })
    }
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(join(stage, 'npm-shrinkwrap.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
      packages: { '': { name: manifest.name, version: manifest.version, peerDependencies: manifest.peerDependencies, peerDependenciesMeta: manifest.peerDependenciesMeta } } }, null, 2) + '\n')
    const destination = resolve(root, 'dist')
    await mkdir(destination, { recursive: true })
    const { stdout } = await promisify(execFile)(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
      { cwd: stage, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, npm_config_update_notifier: 'false' } })
    const [{ files }] = JSON.parse(stdout)
    const filename = releaseFilename(manifest)
    const archive = join(destination, filename)
    const bytes = await readFile(archive)
    const record = { name: manifest.name, version: manifest.version, filename, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), files: files.length }
    await writeFile(archive + '.sha256', `${record.sha256}  ${filename}\n`)
    await writeFile(archive + '.json', JSON.stringify(record, null, 2) + '\n')
    console.log(JSON.stringify(record))
    return record
  } finally {
    if (dirname(stage) !== resolve(tmpdir()) || !stage.startsWith(join(tmpdir(), 'dsh-ez-tree-release-'))) throw new Error('临时发布目录越界。')
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('生成预编译插件包及 SHA256。\n用法：node scripts/pack.mjs [--skip-build]\n示例：npm run pack:release')
  else await packRelease({ skipBuild: process.argv.includes('--skip-build') })
}
