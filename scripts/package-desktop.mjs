import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAll, root } from './build.mjs'
import { verifyDesktop } from './verify-desktop.mjs'

const run = promisify(execFile)
const options = { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
export async function inventory(directory) {
  const result = []
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`发布物不能包含链接：${absolute}`)
      if (entry.isDirectory()) await visit(absolute)
      else {
        const bytes = await readFile(absolute)
        const metadata = await stat(absolute)
        result.push({ path: relative(directory, absolute).split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          ...((metadata.mode & 0o111) ? { executable: true } : {}) })
      }
    }
  }
  await visit(directory)
  return result
}

async function reset(path, expected) {
  if (resolve(path) !== resolve(root, expected)) throw new Error('清理目录越界。')
  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true })
}

export async function packageDesktop({ skipBuild = false } = {}) {
  if (!skipBuild) await buildAll()
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json')))
  const platform = process.platform
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error('当前平台不支持打包。')
  const stage = resolve(root, '.build/desktop')
  await reset(stage, '.build/desktop')
  await cp(resolve(root, 'lib/desktop'), join(stage, 'lib/desktop'), { recursive: true })
  await cp(resolve(root, 'lib/mcp'), join(stage, 'lib/mcp'), { recursive: true })
  await cp(resolve(root, 'lib/editor'), join(stage, 'lib/editor'), { recursive: true })
  for (const file of ['LICENSE', 'NOTICE']) await cp(resolve(root, file), join(stage, file))
  if (existsSync(resolve(root, 'licenses'))) await cp(resolve(root, 'licenses'), join(stage, 'licenses'), { recursive: true })
  await cp(resolve(root, 'vendor/ez-tree/LICENSE'), join(stage, 'UPSTREAM-LICENSE'))
  const thirdParty = join(stage, 'third-party')
  await mkdir(thirdParty, { recursive: true })
  // SDK 依赖已被打包；保留实际被分发代码的许可，不依赖开发目录。
  for (const name of ['three', 'tweakpane', 'zod', '@modelcontextprotocol/sdk']) {
    const source = resolve(root, 'node_modules', name)
    for (const filename of await readdir(source)) if (/^licen[sc]e(?:\.|$)/i.test(filename)) await cp(join(source, filename), join(thirdParty, name.replaceAll('/', '-') + '-' + filename))
  }
  await cp(resolve(root, 'vendor/ez-tree/provenance.json'), join(stage, 'provenance.json'))
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'dsh-ez-tree-desktop', productName: 'EZ-Tree', version: manifest.version,
    main: 'lib/desktop/main.mjs', type: 'module', description: manifest.description, author: 'asun-labs', license: 'MIT' }, null, 2))
  const output = resolve(root, 'dist/unpacked')
  await reset(output, 'dist/unpacked')
  const config = { appId: 'com.asun-labs.ez-tree', productName: 'EZ-Tree', executableName: 'EZ-Tree', asar: false,
    directories: { app: stage, output }, files: ['**/*'], electronVersion: JSON.parse(await readFile(resolve(root, 'node_modules/electron/package.json'))).version,
    npmRebuild: false, forceCodeSigning: false, win: { signAndEditExecutable: true, icon: resolve(root, 'vendor/ez-tree/src/app/public/android-chrome-512x512.png') }, mac: { identity: null, hardenedRuntime: false },
    linux: { executableName: 'EZ-Tree', category: 'Graphics' } }
  const localElectron = resolve(root, 'node_modules/electron/dist')
  if (existsSync(join(localElectron, platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app' : 'electron'))) config.electronDist = localElectron
  const configPath = resolve(root, '.build/builder.json')
  await writeFile(configPath, JSON.stringify(config))
  const builder = resolve(root, 'node_modules/electron-builder/out/cli/cli.js')
  const built = await run(process.execPath, [builder, '--dir', '--config', configPath, '--publish', 'never'], { ...options, timeout: 600000 })
  if (built.stdout) process.stdout.write(built.stdout)
  if (built.stderr) process.stderr.write(built.stderr)
  const directories = (await readdir(output, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  const directoryName = directories.find(name => platform === 'win32' ? /^win.*-unpacked$/.test(name) : platform === 'linux' ? /^linux.*-unpacked$/.test(name) : /^mac(?:-|$)/.test(name))
  if (!directoryName) throw new Error('未找到桌面打包输出目录。')
  const unpacked = resolve(output, directoryName)
  const executable = platform === 'win32' ? 'EZ-Tree.exe' : platform === 'linux' ? 'EZ-Tree' : 'EZ-Tree.app/Contents/MacOS/EZ-Tree'
  const verifyDirectory = resolve(root, '.build/packaged-verify')
  await mkdir(verifyDirectory, { recursive: true })
  const mcpEntry = platform === 'darwin' ? 'EZ-Tree.app/Contents/Resources/app/lib/mcp/cli.mjs' : 'resources/app/lib/mcp/cli.mjs'
  const report = await verifyDesktop(join(unpacked, executable), { mcpEntry: join(unpacked, mcpEntry) })
  await writeFile(join(verifyDirectory, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
  await cp(join(report.isolatedWorkingDirectory, 'verify-ui/editor.png'), join(verifyDirectory, 'editor.png'))
  // 当前安装器尚无 .app 目录适配：macOS 可验收，但不能生成可安装的受信清单。
  if (platform === 'darwin') return { verified: true, published: false, report, unpacked }
  const filename = `dsh-ez-tree-${manifest.version}-${platform}-${process.arch}.zip`
  const archive = resolve(root, 'dist', filename)
  const python = platform === 'win32' ? 'py' : 'python3'
  const script = 'import os,sys,zipfile\nroot,out=sys.argv[1:]\nwith zipfile.ZipFile(out,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:\n for base,dirs,files in os.walk(root):\n  dirs.sort()\n  for f in sorted(files):\n   p=os.path.join(base,f);z.write(p,os.path.relpath(p,root).replace(os.sep,"/"))\n'
  await run(python, [...(platform === 'win32' ? ['-3'] : []), '-c', script, unpacked, archive], { ...options, timeout: 600000 })
  const bytes = await readFile(archive)
  const release = { url: `https://github.com/asun-labs/dsh-ez-tree/releases/download/v${manifest.version}/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, executable, mcp: { entry: mcpEntry, env: { ELECTRON_RUN_AS_NODE: '1' } }, files: await inventory(unpacked) }
  const trustedPath = resolve(root, 'releases/runtime.json')
  const previous = existsSync(trustedPath) ? JSON.parse(await readFile(trustedPath)) : {}
  if (previous.version !== undefined && previous.version !== manifest.version) throw new Error('发布清单版本不一致，拒绝混合平台。')
  const trusted = { ...previous, appId: 'com.asun-labs.ez-tree', version: manifest.version, platforms: { ...previous.platforms, [`${platform}-${process.arch}`]: release } }
  await mkdir(resolve(root, 'releases'), { recursive: true })
  await writeFile(trustedPath, JSON.stringify(trusted, null, 2) + '\n')
  await writeFile(archive + '.sha256', `${release.sha256}  ${filename}\n`)
  await writeFile(archive + '.validation.json', JSON.stringify({ ...report, archiveSha256: release.sha256 }, null, 2) + '\n')
  console.log(JSON.stringify({ archive, bytes: release.bytes, sha256: release.sha256, files: release.files.length }))
  return { archive, unpacked, release }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('打包并真实验证当前平台独立应用。\n用法：node scripts/package-desktop.mjs [--skip-build]\n示例：npm run desktop:pack')
  else await packageDesktop({ skipBuild: process.argv.includes('--skip-build') })
}
