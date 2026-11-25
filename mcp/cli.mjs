import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { dataDirectory } from '../desktop/paths.mjs'
import { createMcpServer } from './server.mjs'
import { openRenderer } from './pipe.mjs'

const VERSION = '0.1.0'

async function main() {
  const options = {}
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') return process.stdout.write('EZ Tree MCP 启动器\n使用随包 Electron 的嵌入 Node 模式启动本文件，连接器配置详见 docs/mcp.md。\n选项：--account <账号> --output-dir <目录>\n')
    if (argv[index] === '--version') return process.stdout.write(`${VERSION}\n`)
    const key = ({ '--account': 'account', '--output-dir': 'outputDirectory', '--app-entry': 'appEntry' })[argv[index]]
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`无效 MCP 启动参数：${argv[index]}`)
    options[key] = argv[++index]
  }
  const outputDirectory = resolve(options.outputDirectory || join(dataDirectory({ account: options.account }), 'exports'))
  await mkdir(outputDirectory, { recursive: true })
  let editor
  let server
  let closing = false
  const shutdown = async (code = 0) => {
    if (closing) return
    closing = true
    const forced = setTimeout(() => process.exit(code), 4000).unref()
    try { await server?.close(); await editor?.close() }
    catch (error) { process.stderr.write(`${error.message}\n`); code = 1 }
    clearTimeout(forced)
    process.exit(code)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
  process.stdin.once('end', () => void shutdown())
  editor = await openRenderer({ executable: process.execPath, appEntry: options.appEntry, account: options.account,
    onFailure: error => { process.stderr.write(`[ez-tree] ${error.message}\n`); void shutdown(1) } })
  server = await createMcpServer({ editor, outputDirectory, version: VERSION, onClose: () => void shutdown() })
  process.stderr.write('[ez-tree] MCP stdio ready\n')
}

main().catch(error => { process.stderr.write(`EZ Tree MCP startup failed: ${error.stack ?? error.message}\n`); process.exit(1) })
