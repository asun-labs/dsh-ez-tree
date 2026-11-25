import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, lstat, realpath, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function safeDirectory(path) {
  const target = resolve(path)
  const parent = dirname(target)
  if (parent !== target) await safeDirectory(parent)
  try {
    const stat = await lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('受管理目录不能是链接或普通文件。')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    try { await mkdir(target) }
    catch (created) { if (created.code !== 'EEXIST') throw created }
    const stat = await lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('受管理目录不能是链接或普通文件。')
  }
  return target
}

async function verifyDirectory(path) {
  const target = resolve(path)
  const parent = dirname(target)
  if (parent !== target) await verifyDirectory(parent)
  const stat = await lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('应用目录不能包含链接。')
}

const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value

export function safeEntry(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.includes(':') || /[\x00-\x1f]/.test(name)) throw new Error('安装包路径无效。')
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('安装包包含危险路径。')
  return parts
}

export async function extractVerified(archive, destination, files, signal) {
  await safeDirectory(destination)
  const expected = new Map(files.map(file => [file.path, file]))
  if (expected.size !== files.length || files.length > 5000) throw new Error('安装包文件清单无效。')
  const seen = new Set()
  const zip = await new Promise((ok, fail) => yauzl.open(archive, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? fail(error) : ok(value)))
  let total = 0
  try {
    await new Promise((ok, fail) => {
      zip.on('error', fail)
      zip.on('end', ok)
      zip.on('entry', entry => {
        void (async () => {
          signal?.throwIfAborted()
          const parts = safeEntry(entry.fileName)
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000
          if (mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000)) throw new Error('安装包不能包含链接或特殊文件。')
          const key = parts.join('/').toLowerCase()
          if (seen.has(key)) throw new Error('安装包包含重复路径。')
          seen.add(key)
          if (seen.size > 10000) throw new Error('安装包条目数量超过限制。')
          const output = join(destination, ...parts)
          if (!output.startsWith(resolve(destination) + sep)) throw new Error('安装包路径越界。')
          if (entry.fileName.endsWith('/')) await safeDirectory(output)
          else {
            const record = expected.get(parts.join('/'))
            total += entry.uncompressedSize
            if (!record || entry.uncompressedSize !== record.bytes || total > 1024 ** 3) throw new Error('安装包与发布清单不匹配。')
            await safeDirectory(dirname(output))
            const stream = await new Promise((yes, no) => zip.openReadStream(entry, (error, value) => error ? no(error) : yes(value)))
            await pipeline(stream, createWriteStream(output, { flags: 'wx', mode: record.executable ? 0o755 : 0o644 }), { signal })
            if (await hashFile(output) !== record.sha256) throw new Error(`安装文件校验失败：${record.path}`)
            expected.delete(record.path)
          }
          zip.readEntry()
        })().catch(fail)
      })
      zip.readEntry()
    })
    if (expected.size) throw new Error('安装包缺少发布清单中的文件。')
  } finally { zip.close() }
}

export async function validateInstalled(directory, release) {
  await verifyDirectory(directory)
  const canonicalRoot = await realpath(directory)
  const verifiedParents = new Set()
  for (const file of release.files) {
    safeEntry(file.path)
    const path = join(directory, file.path)
    if (!verifiedParents.has(dirname(path))) {
      await verifyDirectory(dirname(path))
      verifiedParents.add(dirname(path))
    }
    const stat = await lstat(path)
    const real = await realpath(path)
    if (!normalized(real).startsWith(normalized(canonicalRoot + sep))) throw new Error('应用文件越出受管理目录。')
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || await hashFile(path) !== file.sha256) throw new Error(`应用文件损坏，请重新安装：${file.path}`)
  }
  return JSON.parse(await readFile(join(directory, 'resources/app/package.json'), 'utf8'))
}
