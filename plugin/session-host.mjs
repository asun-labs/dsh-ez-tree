import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parse as parseYaml } from 'yaml'
import { packageRoot } from './runtime.mjs'
import { BrowserPageService } from './browser-page-service.mjs'

const providerName = 'dsh-ez-tree-bundled'
const hash = value => createHash('sha256').update(value).digest('hex')
const service = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
const rejected = (code, message) => Object.assign(new Error(message), { code })
const validSession = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value)
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw rejected('invalidInput', '编辑器请求格式无效。')
  return value
}
function revision(value, required = false) {
  if (value === undefined && !required) return
  if (!Number.isSafeInteger(value) || value < 0) throw rejected('invalidInput', '请提供当前项目的有效修订号。')
}
function operationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw rejected('invalidInput', '编辑操作标识无效。')
}
function editInput(value, required = false) {
  revision(value.expectedRevision, required)
  if (value.preset !== undefined && (typeof value.preset !== 'string' || !value.preset || value.preset.length > 128)) throw rejected('invalidInput', '树种预设无效。')
  if (value.options !== undefined && (!value.options || typeof value.options !== 'object' || Array.isArray(value.options))) throw rejected('invalidInput', '树木参数必须为对象。')
}
function exportInput(value) {
  if (!['glb', 'png', 'json'].includes(value.format) || value.name !== undefined && (typeof value.name !== 'string' || !value.name || value.name.length > 160)) throw rejected('invalidInput', '导出格式或名称无效。')
}
async function readSkill(path) {
  const raw = await readFile(path, 'utf8')
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error('内置 EZ-Tree 技能缺少元数据。')
  const metadata = parseYaml(match[1])
  if (metadata?.name !== 'ez-tree' || typeof metadata.description !== 'string' || !metadata.description.trim()) throw new Error('内置 EZ-Tree 技能元数据无效。')
  return { raw, name: metadata.name, description: metadata.description, content: match[2],
    invocation: { modelInvocable: metadata['disable-model-invocation'] !== true, userInvocable: metadata['user-invocable'] !== false } }
}

export function registerNativeEditor(ctx, { store, skillPath = join(packageRoot, 'skills/ez-tree/SKILL.md'),
  legacySkillPath = join(packageRoot, 'resources/legacy-skills/ez-tree-0.1.1.md'), editorDirectory, browserOptions = {} } = {}) {
  if (!store) throw new Error('缺少编辑器项目服务。')
  const tools = service(ctx, 'tools'), skills = service(ctx, 'skills'), workingDirectory = service(ctx, 'workingDirectory')
  if (!tools || !skills || !workingDirectory) throw new Error('编辑器需要原生工具、技能与工作目录服务。')
  const lifetime = new AbortController()
  let identityLifetime = new AbortController()
  let disposed = false, invalidateSkills = () => {}, lastSignature
  const agents = new Map()
  const disposers = []
  let browserPages
  let compatibility = { state: 'checking', message: '' }
  function scope() {
    if (disposed) throw rejected('disposed', '树木编辑器插件已卸载。')
    const identity = service(ctx, 'sealHarnessIdentity')
    if (!identity) return { accountId: 'local-owner', epoch: 0, mode: 'local' }
    const account = identity.getSession()
    if (!account?.accountId) throw rejected('authenticationRequired', '请先登录当前 Seal 账号。')
    return { accountId: account.accountId, epoch: account.epoch ?? 0, mode: 'seal' }
  }
  const signature = account => JSON.stringify([account.mode, account.accountId, account.epoch])
  const accountScope = account => hash(signature(account)).slice(0, 24)
  function assertScope(account) {
    lifetime.signal.throwIfAborted()
    if (signature(scope()) !== signature(account)) throw rejected('identityChanged', '账号已变化，请在当前会话重新打开编辑器。')
  }
  function signal(parent) { return AbortSignal.any([lifetime.signal, identityLifetime.signal, ...(parent ? [parent] : [])]) }
  function assertSession(account, sessionId, requestSignal) {
    assertScope(account)
    requestSignal?.throwIfAborted()
    if (!validSession(sessionId)) throw rejected('invalidSession', '会话标识无效。')
    const registry = service(ctx, 'agents')
    const agent = agents.get(`${signature(account)}:${sessionId}`) ?? registry?.get(sessionId)
    if (!agent || String(agent.id) !== sessionId) throw rejected('sessionUnavailable', '当前会话尚未就绪，请先在该会话调用树木编辑技能。')
    return agent
  }
  async function editable(account, sessionId, requestSignal, { allowPending = false } = {}) {
    const snapshot = await store.read(account, sessionId)
    const project = allowPending && snapshot.command?.kind === 'apply' ? snapshot.command.project : snapshot.project
    if (!project) throw rejected('projectMissing', '请先在当前会话调用树木编辑技能。')
    const agent = assertSession(account, sessionId, requestSignal)
    const workspace = await realpath(await workingDirectory.ensure(agent, requestSignal))
    assertScope(account)
    if (!samePath(workspace, project.workspace)) throw rejected('workspaceChanged', '当前会话工作目录已变化，请重新调用打开树木编辑器后再修改或导出。')
    return snapshot
  }
  async function executeTool(kind, args, execution) {
    const allowed = kind === 'generate' ? ['expectedRevision', 'preset', 'options'] : kind === 'export' ? ['format', 'name'] : []
    object(args, allowed)
    const agent = execution?.agent
    if (!agent || !validSession(String(agent.id))) throw rejected('sessionUnavailable', '树木编辑器工具必须在当前会话执行。')
    const account = scope(), sessionId = String(agent.id), requestSignal = signal(execution.signal)
    agents.set(`${signature(account)}:${sessionId}`, agent)
    const workspace = await realpath(await workingDirectory.ensure(agent, requestSignal))
    assertScope(account)
    let result
    if (kind === 'get') {
      result = await store.read(account, sessionId)
      if (!result.project) throw rejected('projectMissing', '请先调用 ez_tree_open_editor 打开当前会话的树木编辑器。')
    } else {
      if (kind === 'generate') editInput(args)
      if (kind === 'export') exportInput(args)
      const opened = await store.open(account, sessionId, { workspace, signal: requestSignal })
      assertScope(account)
      result = kind === 'generate' ? await store.edit(account, sessionId, { ...args, signal: requestSignal })
        : kind === 'export' ? await store.export(account, sessionId, { ...args, signal: requestSignal }) : opened
    }
    assertScope(account)
    return JSON.stringify(result)
  }
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
  const specifications = [
    ['ez_tree_open_editor', 'open', '在当前会话按需打开真实三维树木编辑面板，恢复项目并等待模型渲染成功。无需配置 MCP 或安装外部桌面运行时。', {}],
    ['ez_tree_editor_get', 'get', '读取当前会话已打开树木项目的实际参数、预设、修订号与状态；不能读取或指定其他会话。', {}],
    ['ez_tree_editor_generate', 'generate', '在当前会话的真实三维面板中生成或修改树木，等待渲染确认后提交参数；与用户手动编辑共享项目状态。', {
      expectedRevision: { type: 'integer', description: '可选的当前项目修订号；不匹配时保留最新项目并拒绝覆盖。' },
      preset: { type: 'string', description: '已有树种预设的准确名称。' }, options: { type: 'object', additionalProperties: true, description: '需要修改的树木参数，由生成器校验。' },
    }],
    ['ez_tree_editor_export', 'export', '从当前会话三维面板导出真实 GLB、PNG 或参数 JSON，保存到当前工作目录 models/ez-tree，不覆盖已有成果。', {
      format: { type: 'string', required: true, enum: ['glb', 'png', 'json'] }, name: { type: 'string', description: '可选文件名，不接受目录路径。' },
    }],
  ]
  for (const [name, kind, description, parameters] of specifications)
    disposers.push(tools.register(defineTool({ name, description, parameters, output, timeoutMs: 180000, execute: (args, execution) => executeTool(kind, args, execution) })))
  disposers.push(skills.registerProvider(control => {
    invalidateSkills = control.invalidate
    return { name: providerName, async list(options) {
      options.signal?.throwIfAborted()
      let account
      try { account = scope() } catch (error) { if (error.code === 'authenticationRequired') return []; throw error }
      const skill = await readSkill(skillPath)
      assertScope(account)
      return [{ name: skill.name, description: skill.description, invocation: skill.invocation, source: 'bundled', provider: providerName,
        rank: 600, locator: 'ez-tree', path: skillPath, resourceBase: { kind: 'directory', path: dirname(skillPath) } }]
    }, async get(candidate, options) {
      options.signal?.throwIfAborted()
      if (candidate.locator !== 'ez-tree') return
      const account = scope(), skill = await readSkill(skillPath)
      assertScope(account)
      return { name: skill.name, description: skill.description, invocation: skill.invocation, source: 'bundled', provider: providerName,
        content: skill.content, path: skillPath, resourceBase: { kind: 'directory', path: dirname(skillPath) } }
    } }
  }))
  async function compatibilityCheck() {
    let account
    try { account = scope() } catch { return }
    try {
      const managed = service(ctx, 'sealHarnessSkills')
      if (managed) {
        const listing = await managed.call('list', {}, signal())
        assertScope(account)
        const legacy = listing.skills.find(item => item.name === 'ez-tree' && item.installed !== false && item.enabled && item.origin?.kind === 'local')
        if (legacy) {
          const detail = await managed.call('detail', { id: legacy.id }, signal())
          const known = await readFile(legacySkillPath)
          assertScope(account)
          if (typeof detail.rawContent === 'string' && hash(Buffer.from(detail.rawContent)) === hash(known)) {
            await managed.call('setEnabled', { id: legacy.id, enabled: false, expectedRevision: listing.revision }, signal())
            assertScope(account)
            compatibility = { state: 'legacyDisabled', message: '已停用内容完全匹配的旧版技能副本，原文件与配置保留；当前使用插件内置会话编辑技能。' }
            invalidateSkills()
          }
        }
      }
      if (typeof skills.list === 'function') {
        const listing = await skills.list({ signal: signal() })
        assertScope(account)
        const winner = listing.find(item => item.name === 'ez-tree')
        if (winner && winner.provider !== providerName) {
          compatibility = { state: 'customSkillShadow', message: '当前同名自定义技能优先级更高，已保留用户内容；可直接使用 ez_tree_open_editor 打开当前会话编辑器。' }
          ctx.logger?.warn?.(compatibility.message)
        } else if (compatibility.state === 'checking') compatibility = { state: 'ready', message: '' }
      } else if (compatibility.state === 'checking') compatibility = { state: 'ready', message: '' }
    } catch (error) {
      if (disposed) return
      compatibility = { state: 'unavailable', message: `旧技能兼容检查未完成：${error.message}` }
      ctx.logger?.warn?.(compatibility.message)
    }
  }
  function identityChanged() {
    let current
    try { current = signature(scope()) } catch { current = null }
    if (lastSignature !== undefined && current !== lastSignature) {
      identityLifetime.abort(rejected('identityChanged', '账号已变化。'))
      identityLifetime = new AbortController()
      agents.clear()
      store.cancelAll(rejected('identityChanged', '账号已变化，请重新打开编辑器。'))
      browserPages?.revokeAll('账号已变化，请在当前会话重新打开编辑器。')
      compatibility = { state: 'checking', message: '' }
      invalidateSkills()
      void compatibilityCheck()
    }
    lastSignature = current
  }
  identityChanged()
  if (ctx.inject) ctx.inject(['sealHarnessIdentity'], inner => inner.effect(() => {
    const unsubscribe = service(inner, 'sealHarnessIdentity').subscribe(identityChanged)
    identityChanged()
    return () => { unsubscribe(); identityChanged() }
  }, 'dsh-ez-tree: session identity'))
  else {
    const identity = service(ctx, 'sealHarnessIdentity')
    if (identity?.subscribe) disposers.push(identity.subscribe(identityChanged))
  }
  const ready = compatibilityCheck()
  const handlers = {
    async editorRead(payload, requestSignal) {
      const value = object(payload, ['sessionId'])
      if (!validSession(value.sessionId)) throw rejected('invalidSession', '会话标识无效。')
      const account = scope(), snapshot = await store.read(account, value.sessionId)
      requestSignal?.throwIfAborted(); assertScope(account)
      return { ...snapshot, accountScope: accountScope(account), compatibility: { ...compatibility }, browserView: browserPages.state(account, value.sessionId) }
    },
    async editorWatch(payload, requestSignal) {
      const value = object(payload, ['sessionId', 'afterCursor'])
      if (!validSession(value.sessionId)) throw rejected('invalidSession', '会话标识无效。')
      revision(value.afterCursor)
      const account = scope(), snapshot = await store.watch(account, value.sessionId, value.afterCursor ?? 0, signal(requestSignal))
      assertScope(account)
      return { ...snapshot, accountScope: accountScope(account), compatibility: { ...compatibility }, browserView: browserPages.state(account, value.sessionId) }
    },
    async editorBrowserLaunch(payload, parentSignal) {
      const value = object(payload, ['sessionId'])
      if (!validSession(value.sessionId)) throw rejected('invalidSession', '会话标识无效。')
      const account = scope(), requestSignal = signal(parentSignal)
      const snapshot = await editable(account, value.sessionId, requestSignal, { allowPending: true })
      const project = snapshot.command?.kind === 'apply' ? snapshot.command.project : snapshot.project
      const launched = await browserPages.launch(account, value.sessionId, { workspace: project.workspace, signal: requestSignal })
      assertScope(account)
      return { ...launched, accountScope: accountScope(account) }
    },
    async editorEdit(payload, parentSignal) {
      const value = object(payload, ['sessionId', 'expectedRevision', 'preset', 'options'])
      editInput(value, true)
      const account = scope(), requestSignal = signal(parentSignal)
      await editable(account, value.sessionId, requestSignal)
      const result = await store.edit(account, value.sessionId, { expectedRevision: value.expectedRevision, preset: value.preset, options: value.options, signal: requestSignal })
      assertScope(account)
      return { ...result, accountScope: accountScope(account) }
    },
    async editorExport(payload, parentSignal) {
      const value = object(payload, ['sessionId', 'format', 'name'])
      exportInput(value)
      const account = scope(), requestSignal = signal(parentSignal)
      await editable(account, value.sessionId, requestSignal)
      const artifact = await store.export(account, value.sessionId, { format: value.format, name: value.name, signal: requestSignal })
      assertScope(account)
      return { ...artifact, accountScope: accountScope(account) }
    },
    async editorAck(payload, parentSignal) {
      const value = object(payload, ['sessionId', 'operationId', 'revision', 'optionsDigest', 'metrics'])
      operationId(value.operationId); revision(value.revision, true)
      if (typeof value.optionsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.optionsDigest)) throw rejected('invalidInput', '项目参数摘要无效。')
      object(value.metrics, ['vertexCount', 'triangleCount'])
      if (![value.metrics.vertexCount, value.metrics.triangleCount].every(number => Number.isSafeInteger(number) && number > 0)) throw rejected('invalidInput', '实际渲染统计无效。')
      const account = scope()
      await editable(account, value.sessionId, signal(parentSignal), { allowPending: true })
      const result = await store.ack(account, value.sessionId, { operationId: value.operationId, revision: value.revision, optionsDigest: value.optionsDigest, metrics: value.metrics })
      assertScope(account)
      return { ...result, accountScope: accountScope(account) }
    },
    async editorFail(payload, parentSignal) {
      const value = object(payload, ['sessionId', 'operationId', 'message'])
      operationId(value.operationId)
      if (typeof value.message !== 'string' || !value.message || value.message.length > 2000) throw rejected('invalidInput', '渲染失败说明无效。')
      const account = scope()
      assertSession(account, value.sessionId, parentSignal)
      const snapshot = await store.read(account, value.sessionId)
      if (!snapshot.project && !snapshot.command?.project) throw rejected('projectMissing', '当前会话没有树木项目。')
      const result = await store.fail(account, value.sessionId, value.operationId, value.message)
      assertScope(account)
      return { ...result, accountScope: accountScope(account) }
    },
  }
  browserPages = new BrowserPageService({ ...browserOptions, ctx, store, scope, assertScope, handlers, editorDirectory,
    async checkView(account, sessionId, workspace, requestSignal) {
      const agent = assertSession(account, sessionId, requestSignal)
      const current = await realpath(await workingDirectory.ensure(agent, requestSignal))
      assertScope(account)
      if (!samePath(current, workspace)) throw rejected('workspaceChanged', '当前会话工作目录已变化，请重新调用技能打开编辑器。')
    } })
  return { handlers, ready, scope, assertScope, compatibility: () => ({ ...compatibility }), async handle(action, payload, requestSignal, peer) {
    if (peer?.principal?.kind !== 'owner') return { ok: false, error: { code: 'forbidden', message: '仅当前所有者可以操作树木编辑器。', details: {} } }
    try {
      if (!Object.hasOwn(handlers, action)) throw rejected('invalidInput', '未知编辑器操作。')
      return { ok: true, value: await handlers[action](payload, requestSignal) }
    } catch (error) {
      const aborted = error.name === 'AbortError'
      return { ok: false, error: { code: typeof error.code === 'string' ? error.code : aborted ? 'cancelled' : 'editorFailed', message: aborted ? '编辑操作已取消。' : error.message, details: {} } }
    }
  }, async dispose() {
    if (disposed) return
    disposed = true
    lifetime.abort()
    identityLifetime.abort()
    await browserPages.dispose()
    for (const dispose of disposers.reverse()) await dispose()
    store.cancelAll(rejected('disposed', '树木编辑器插件已卸载。'))
  } }
}
