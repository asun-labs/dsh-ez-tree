import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const base = fileURLToPath(new URL('../vendor/ez-tree/', import.meta.url))
async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (entry.name !== 'provenance.json') result.push(path)
  }
  return result.sort()
}
const current = Object.fromEntries(await Promise.all((await files(base)).map(async path => [relative(base, path).replaceAll('\\', '/'), createHash('sha256').update(await readFile(path)).digest('hex')])))
const manifestPath = join(base, 'provenance.json')
if (process.argv.includes('--write')) {
  await writeFile(manifestPath, JSON.stringify({ repository: 'https://github.com/ASunYC/ez-tree', upstreamRepository: 'https://github.com/dgreenheck/ez-tree', commit: '135ac2bf85875eacf5637d18062e690cf16a1837', license: 'MIT', attribution: 'Copyright (c) 2024 Daniel Greenheck', adaptations: ['遥测脚本不进入应用入口；静态资源离线交付', '自动化渲染省去环境与背景树；交互编辑器保留原环境', '几何索引使用 Uint32，避免大模型索引溢出；vendor 原文件保持未修改', '岩石 Draco 解码器改为 Three 包内随附的本地版本，不访问 gstatic'], files: current }, null, 2) + '\n')
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (JSON.stringify(manifest.files) !== JSON.stringify(current)) throw new Error('上游文件 SHA-256 不匹配。')
  console.log(`已验证 ${Object.keys(current).length} 个上游文件。`)
}
