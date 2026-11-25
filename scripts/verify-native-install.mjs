import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { releaseFilename } from './pack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = promisify(execFile)

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

export async function verifyNativeInstall({ cli, archive, ui = true } = {}) {
  assert.ok(cli, '请通过 --cli 提供已安装官方 DSH CLI 的 lib/bin.js。')
  const absoluteCli = resolve(cli)
  const manifest = JSON.parse(await readFile(join(root, 'package.json')))
  assert.equal(manifest.name, 'dsh-ez-tree', '原生安装验收必须使用正式 canonical 包名。')
  const artifact = archive ? resolve(archive) : join(root, 'dist', releaseFilename(manifest))
  const bytes = await readFile(artifact)
  const base = join(root, '.build/native-install')
  await mkdir(base, { recursive: true })
  const output = await mkdtemp(join(base, 'run-'))
  const home = join(output, 'home')
  const environment = { ...process.env, DSH_HOME: home, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
  const invoke = async args => {
    const result = await run(process.execPath, [absoluteCli, ...args], { cwd: root, env: environment, windowsHide: true,
      timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
    return result.stdout
  }
  await invoke(['--profile', 'web', '--dump-config'])
  const install = await invoke(['plugin', '--profile', 'web', 'add', artifact, '--ignore-scripts'])
  await writeFile(join(output, 'install.log'), install)
  const profileDir = join(home, 'profiles/web')
  const profile = JSON.parse(await readFile(join(profileDir, 'package.json')))
  assert.ok(profile.dependencies[manifest.name], '原生 CLI 未安装指定插件依赖。')
  assert.ok(profile.dsh.profile.bundles.includes(manifest.name), '原生 CLI 未激活插件 bundle。')
  const installedRoot = join(profileDir, 'node_modules', manifest.name)
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json')))
  assert.equal(installed.version, manifest.version)
  assert.equal(installed.scripts, undefined, '发行包不应依赖安装时构建。')
  const composed = await invoke(['--profile', 'web', '--dump-config'])
  assert.ok(composed.includes(manifest.name), '组合配置未包含正式插件身份。')
  assert.ok(!composed.includes('@asun-labs/dsh-ez-tree'), '新安装不应激活旧 scoped 包。')
  await writeFile(join(output, 'composed-profile.yml'), composed)
  const client = await readFile(join(installedRoot, installed.exports['./client']), 'utf8')
  assert.ok(client.includes(`id: "${manifest.name}"`), '客户端 Loader ID 与插件 npm 身份不一致。')
  const report = { package: `${installed.name}@${installed.version}`, archive: artifact,
    sha256: createHash('sha256').update(bytes).digest('hex'), home, profile: 'web', install: 'passed', bundle: 'passed', clientLoaderId: 'passed' }
  if (ui) Object.assign(report, await verifyWebUi({ cli: absoluteCli, environment, output }))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, report: join(output, 'report.json') }, null, 2))
  return report
}

async function verifyWebUi({ cli, environment, output }) {
  const server = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let outputText = ''
  let exited = false
  server.once('exit', () => { exited = true })
  server.stdout.setEncoding('utf8'); server.stderr.setEncoding('utf8')
  const capture = text => { outputText = (outputText + text).slice(-1024 * 1024) }
  server.stdout.on('data', capture); server.stderr.on('data', capture)
  try {
    const deadline = Date.now() + 120000
    let url
    while (!url) {
      url = outputText.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/)?.[1]
      if (url) break
      if (exited) throw new Error(`原生 Web Host 在就绪前退出：${outputText.slice(-12000)}`)
      if (Date.now() > deadline) throw new Error('原生 Web Host 启动超时。')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const runtimeRequire = createRequire(cli)
    const { chromium } = runtimeRequire('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    let result
    try {
      await page.goto(url)
      await page.waitForFunction(panelProbe, null, { timeout: 60000 })
      const continueButton = page.getByRole('button', { name: '继续', exact: true })
      if (await continueButton.count()) await continueButton.click()
      await page.waitForFunction(() => !document.querySelector('[data-plugin="dsh-ez-tree"]').textContent.includes('正在读取…'))
      assert.equal(await page.locator('[data-plugin="dsh-ez-tree"] [role="alert"]').count(), 0)
      result = { heading: await page.locator('[data-plugin="dsh-ez-tree"] h1').textContent(), text: await page.locator('body').innerText(), pageErrors }
    } catch (error) {
      const diagnostic = { message: error.message.replaceAll(url, '[authenticated URL omitted]'), pageErrors, text: await page.locator('body').innerText() }
      await writeFile(join(output, 'browser-error.json'), JSON.stringify(diagnostic, null, 2))
      throw new Error(`原生客户端验证失败：${diagnostic.message}`)
    } finally {
      await page.screenshot({ path: join(output, 'native-panel.png'), fullPage: true })
      await browser.close()
    }
    await writeFile(join(output, 'browser.json'), JSON.stringify(result, null, 2))
    assert.equal(result.heading, '树木生成器')
    assert.ok(result.text.includes('安装桌面应用'))
    assert.equal(result.pageErrors.length, 0, result.pageErrors.join('\n'))
    return { host: 'passed', nativeClientPanel: 'passed', screenshot: join(output, 'native-panel.png') }
  } finally {
    server.kill()
    await writeFile(join(output, 'host.log'), outputText.replace(/dsh web: http[^\r\n]+/g, 'dsh web: [authenticated URL omitted]'))
    const stopped = new Promise(resolve => server.once('exit', resolve))
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 10000).unref())])
    if (!exited && process.platform === 'win32') await run('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
  }
}

const panelProbe = `(()=>{const trigger=[...document.querySelectorAll('button,[role="button"]')].find(el=>el.title==='树木生成器'||el.getAttribute('aria-label')==='树木生成器'||el.textContent.trim()==='树木生成器');if(trigger)trigger.click();return document.querySelector('[data-plugin="dsh-ez-tree"] h1')?.textContent||''})()`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('在隔离 DSH_HOME 中用官方 CLI 安装精确 tgz，并用无头 Playwright 验证原生 Host/Client。CLI 安装需能解析 Playwright，且已安装 Chromium。\n用法：node scripts/verify-native-install.mjs --cli <DSH/lib/bin.js> [--package <发行.tgz>] [--skip-ui]\n示例：node scripts/verify-native-install.mjs --cli C:/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
  else await verifyNativeInstall({ cli: argument('--cli'), archive: argument('--package'), ui: !process.argv.includes('--skip-ui') })
}
