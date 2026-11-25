import { build } from 'esbuild'
import { build as viteBuild } from 'vite'
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))

async function licenses(inputs, destination) {
  const packages = [...new Set(Object.keys(inputs).filter(path => path.startsWith('node_modules/')).map(path => {
    const [first, second] = path.slice('node_modules/'.length).split('/')
    return first.startsWith('@') ? `${first}/${second}` : first
  }))].sort()
  await mkdir(destination, { recursive: true })
  const records = []
  for (const name of packages) {
    const directory = resolve(root, 'node_modules', name)
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json')))
    records.push({ name, version: manifest.version, license: manifest.license ?? 'SEE LICENSE' })
    for (const filename of await readdir(directory)) if (/^(licen[sc]e|copying|notice)(\.|$)/i.test(filename)) await copyFile(resolve(directory, filename), resolve(destination, name.replaceAll('/', '-') + '-' + filename))
  }
  await writeFile(resolve(destination, 'dependencies.json'), JSON.stringify(records, null, 2) + '\n')
}

export async function buildAll() {
  await mkdir(resolve(root, 'lib/plugin'), { recursive: true })
  const common = { bundle: true, sourcemap: true, minify: false, target: 'node22', platform: 'node', format: 'esm',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, absWorkingDir: root }
  const desktop = await build({ ...common, metafile: true, entryPoints: ['desktop/main.mjs'], outfile: resolve(root, 'lib/desktop/main.mjs'), external: ['electron'] })
  await licenses(desktop.metafile.inputs, resolve(root, 'lib/desktop/licenses'))
  const mcp = await build({ ...common, metafile: true, entryPoints: ['mcp/cli.mjs'], outfile: resolve(root, 'lib/mcp/cli.mjs') })
  await licenses(mcp.metafile.inputs, resolve(root, 'lib/mcp/licenses'))
  const plugin = await build({ ...common, metafile: true, entryPoints: ['plugin/index.mjs'], outfile: resolve(root, 'lib/plugin/index.mjs') })
  const upgrade = await build({ ...common, metafile: true, entryPoints: ['plugin/upgrade-profile.mjs'], outfile: resolve(root, 'lib/upgrade-profile.mjs') })
  await licenses({ ...plugin.metafile.inputs, ...upgrade.metafile.inputs }, resolve(root, 'lib/plugin/licenses'))
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json')))
  const client = { absWorkingDir: root, bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', external: ['react', 'react/*'],
    define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: true }
  await build({ ...client, entryPoints: ['plugin/client.jsx'], outfile: resolve(root, 'lib/plugin/client-api.cjs') })
  await build({ ...client, entryPoints: ['plugin/client.jsx'], outfile: resolve(root, 'lib/plugin/client.js'),
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
    footer: { js: '\nreturn module.exports; } });' } })
  await viteBuild({ configFile: resolve(root, 'app/vite.config.mjs') })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAll()
