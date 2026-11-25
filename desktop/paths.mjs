import { createHash, randomBytes } from 'node:crypto'
import { mkdir, realpath, writeFile, link, unlink, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join, extname, dirname } from 'node:path'

export function dataDirectory({ home = process.env.DSH_HOME, account } = {}) {
  const root = resolve(home || join(homedir(), '.seal-harness'))
  const identity = account ? createHash('sha256').update(account).digest('hex').slice(0, 16) : 'local'
  return join(root, 'ez-tree', 'accounts', identity)
}

export function outputName(format, name) {
  if (!['glb', 'png', 'json'].includes(format)) throw new Error('不支持的导出格式。')
  const basename = name ?? `tree-${Date.now()}-${randomBytes(3).toString('hex')}`
  if (typeof basename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(basename)
    || basename.includes('..') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(basename)) {
    throw new Error('文件名只能包含英文字母、数字、点、下划线和连字符，长度最多 80，且不能使用保留名称。')
  }
  const suffix = extname(basename)
  if (suffix && suffix !== `.${format}`) throw new Error('文件扩展名必须与导出格式一致。')
  return suffix ? basename : `${basename}.${format}`
}

export async function saveExport(outputDirectory, format, name, base64) {
  const basename = outputName(format, name)
  await mkdir(outputDirectory, { recursive: true })
  const root = await realpath(outputDirectory)
  const destination = join(root, basename)
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > 256 * 1024 * 1024) throw new Error('导出文件为空或超过 256 MiB。')
  const temporary = join(root, `.ez-tree-${randomBytes(12).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    // 同目录硬链接原子发布，并以 EEXIST 保护已有用户文件。
    await link(temporary, destination)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return { path: destination, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format }
}

// 仅由本机“另存为”对话框调用；用户已明确选择目标并确认替换。
export async function saveChosenExport(destination, format, base64) {
  if (!['glb', 'png', 'json'].includes(format) || extname(destination).toLowerCase() !== `.${format}`) throw new Error('文件扩展名必须与导出格式一致。')
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > 256 * 1024 * 1024) throw new Error('导出文件为空或超过 256 MiB。')
  const temporary = join(dirname(destination), `.ez-tree-${randomBytes(12).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  return { path: destination, bytes: bytes.length }
}
