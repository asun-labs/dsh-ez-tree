import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

export async function verifyDesktop(executable, { mcpEntry } = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json')))
  const target = resolve(executable || join(root, 'dist/unpacked', process.platform === 'win32' ? 'win-unpacked/EZ-Tree.exe'
    : process.platform === 'darwin' ? 'mac/EZ-Tree.app/Contents/MacOS/EZ-Tree' : 'linux-unpacked/EZ-Tree'))
  if (!existsSync(target)) throw new Error('未找到独立应用发布物，请先执行 npm run desktop:pack，或传入实际安装后的程序路径。')
  const directory = await mkdtemp(join(tmpdir(), 'ez-tree-verify-'))
  const env = { ...process.env, PATH: '', DSH_HOME: join(directory, 'home') }
  delete env.ELECTRON_RUN_AS_NODE
  // 发布验收只运行归档中的应用，不能继承开发调试入口。
  delete env.EZ_TREE_APP_ENTRY
  const options = { cwd: directory, env, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }
  const checks = []
  for (const mode of ['--verify', '--verify-ui']) {
    const output = join(directory, mode.slice(2))
    const result = await run(target, [mode, output, '--account', 'packaged-verification'], options)
    const report = JSON.parse(await readFile(join(output, 'verification.json')))
    if (report.version !== manifest.version || report.artifacts?.length !== 3) throw new Error(`${mode} 验收报告不完整。`)
    checks.push({ mode, report, stderr: result.stderr })
  }
  const mcp = await run(process.execPath, ['--test', join(root, 'tests/mcp-stdio.test.mjs')], {
    ...options, env: { ...env, EZ_TREE_EXECUTABLE: target,
      EZ_TREE_MCP_ENTRY: resolve(mcpEntry || process.env.EZ_TREE_MCP_ENTRY || (process.platform === 'darwin'
        ? join(dirname(target), '../Resources/app/lib/mcp/cli.mjs') : join(dirname(target), 'resources/app/lib/mcp/cli.mjs'))) }, timeout: 180000,
  })
  const report = { version: manifest.version, executable: target, verifiedAt: new Date().toISOString(), platform: process.platform,
    arch: process.arch, isolatedWorkingDirectory: directory, emptyPath: true, checks, mcp: mcp.stdout }
  await writeFile(join(directory, 'desktop-verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, report: join(directory, 'desktop-verification.json'), screenshot: join(directory, 'verify-ui/editor.png') }, null, 2))
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('验证独立应用版本、真实引擎导出、完整界面和 MCP stdio。\n用法：node scripts/verify-desktop.mjs [可执行文件路径]\n示例：npm run verify:desktop -- D:/Apps/EZ-Tree/EZ-Tree.exe\n验收在隔离目录和空 PATH 下运行，不打开或聚焦窗口；结果与截图保留在打印的临时目录。')
  else await verifyDesktop(process.argv[2])
}
