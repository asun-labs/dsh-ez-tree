import React, { useEffect, useRef, useState } from 'react'

export const inject = ['slots', 'layout', 'connection']

const labels = { install: '安装桌面应用', open: '打开编辑器', close: '关闭编辑器', uninstall: '卸载应用', prepareMcp: '准备 MCP', installSkill: '安装内置技能' }
const styles = `
.ez-tree-panel{box-sizing:border-box;padding:28px var(--seal-page-inset,28px);color:var(--dsw-alias-label-primary,inherit);font:inherit;height:100%;overflow:auto}
.ez-tree-panel *{box-sizing:border-box}.ez-tree-panel h1{font-size:24px;line-height:32px;font-weight:600;margin:0 0 12px}
.ez-tree-panel p{line-height:1.7}.ez-tree-panel .ez-tree-muted{color:var(--dsw-alias-label-secondary,inherit)}
.ez-tree-card{border:1px solid var(--dsw-alias-border-l1,currentColor);background:var(--dsw-alias-bg-layer-1,transparent);border-radius:12px;padding:20px;margin:20px 0}
.ez-tree-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.ez-tree-panel button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,currentColor);border-radius:8px;padding:8px 14px;cursor:pointer}
.ez-tree-panel button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,transparent)}.ez-tree-panel button:focus-visible{outline:2px solid currentColor;outline-offset:3px}.ez-tree-panel button:disabled{opacity:.45;cursor:default}
.ez-tree-panel dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px;margin:0}.ez-tree-panel dt{color:var(--dsw-alias-label-secondary,inherit)}.ez-tree-panel dd{margin:0;overflow-wrap:anywhere}
.ez-tree-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6;user-select:text}.ez-tree-panel [role=alert]{border-left:3px solid currentColor;padding-left:12px}
.ez-tree-panel .ez-tree-status{display:flex;align-items:center;gap:10px}.ez-tree-panel .ez-tree-status svg{flex-shrink:0}@media(max-width:600px){.ez-tree-panel{padding:20px 16px}.ez-tree-panel dl{grid-template-columns:1fr;gap:5px}.ez-tree-panel dd{margin-bottom:10px}}
`

export function TreeIcon({ size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 2-6 7h3l-5 6h6v7h4v-7h6l-5-6h3Z" strokeLinejoin="round" /></svg>
}

export function EzTreePanel({ api }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [config, setConfig] = useState(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const currentScope = useRef(null)
  useEffect(() => {
    let mounted = true
    let refreshing = false
    async function refresh() {
      if (refreshing) return
      refreshing = true
      try {
        const value = await api('status')
        if (mounted) {
          if (currentScope.current !== value.accountScope) { setConfig(null); setNotice(''); setConfirmUninstall(false) }
          currentScope.current = value.accountScope
          setState(value); setError('')
        }
      } catch (issue) {
        if (mounted) { currentScope.current = null; setState(null); setConfig(null); setNotice(''); setConfirmUninstall(false); setError(issue.message) }
      }
      finally { refreshing = false }
    }
    void refresh()
    const timer = setInterval(refresh, 2000)
    return () => { mounted = false; clearInterval(timer) }
  }, [api])
  async function act(action) {
    setBusy(action); setError(''); setNotice('')
    try {
      const value = await api(action)
      const latest = await api('status')
      setState(latest)
      if (value.accountScope !== latest.accountScope) throw new Error('账号已变化，请在当前账号重新操作。')
      currentScope.current = latest.accountScope
      if (value.message) setNotice(value.message)
      if (value.config) setConfig(value.config)
    } catch (issue) { setConfig(null); setNotice(''); setError(issue.message) }
    finally { setBusy(''); setConfirmUninstall(false) }
  }
  const waiting = !!busy || !!state?.busy
  const canInstall = !!state && state.supported !== false && state.available !== false
  const installLabel = state?.updateAvailable ? `升级到 ${state.targetVersion}` : '安装桌面应用'
  return <main className="ez-tree-panel" data-plugin="dsh-ez-tree">
    <h1>树木生成器</h1>
    <p className="ez-tree-muted">完整 EZ-Tree 编辑器：实时三维预览、树种预设、枝叶参数、环境调节，以及 GLB、PNG 和参数 JSON 导入导出。</p>
    <section className="ez-tree-card" aria-label="桌面应用">
      <h2 className="ez-tree-status"><TreeIcon size={28} /> EZ-Tree</h2>
      <dl><dt>安装状态</dt><dd>{!state ? '正在读取…' : state.installed ? `已安装 ${state.version ?? ''}` : '尚未安装'}</dd>
        {state?.updateAvailable && <><dt>可用更新</dt><dd>{state.targetVersion}（当前版本可继续使用）</dd></>}
        <dt>运行状态</dt><dd>{waiting ? `${labels[busy || state?.busy] ?? '处理'}中…` : state?.running ? '编辑器运行中' : '未运行'}</dd>
        {state?.dataDirectory && <><dt>数据目录</dt><dd>{state.dataDirectory}</dd></>}
        {state?.identityMode === 'local' && <><dt>账号范围</dt><dd>本机 DSH 所有者</dd></>}
      </dl>
      <p className="ez-tree-muted">安装会下载此插件固定版本的独立桌面程序和资源，无需另外安装 Node.js。项目与导出文件保存在数据目录，卸载应用保留数据。</p>
      {state?.supported === false && <p role="status">当前平台尚无已验证的桌面发行包。</p>}
      <div className="ez-tree-actions">
        <button disabled={waiting || !canInstall || (state?.installed && !state?.updateAvailable) || state?.running} onClick={() => act('install')}>{installLabel}</button>
        <button disabled={waiting || !state?.installed} onClick={() => act('open')}>打开编辑器</button>
        <button disabled={waiting || !state?.running} onClick={() => act('close')}>关闭编辑器</button>
        <button disabled={waiting || !state?.installed} onClick={() => setConfirmUninstall(true)}>卸载应用</button>
      </div>
      {state?.updateAvailable && <p className="ez-tree-muted">升级前请关闭编辑器。升级保留项目、导出和旧版程序，已有 MCP 配置可继续使用；重新准备 MCP 后使用新版。</p>}
      {confirmUninstall && <div role="group" aria-label="确认卸载"><p>卸载 EZ-Tree 程序并保留项目和导出文件？请先保存编辑器中的更改。</p><div className="ez-tree-actions"><button disabled={waiting} onClick={() => act('uninstall')}>确认卸载，保留数据</button><button disabled={waiting} onClick={() => setConfirmUninstall(false)}>取消</button></div></div>}
    </section>
    <section className="ez-tree-card" aria-label="智能体集成"><h2>在会话中使用</h2>
      <p>MCP 使用与编辑器相同的生成引擎，支持查看预设、调整参数、生成模型和导出文件。内置技能提供参数选择和批量生成的操作指导。</p>
      <p className="ez-tree-muted">准备 MCP 与安装技能后，前往连接器和技能页面按需启用，再为需要的会话选择能力。安装不会自动启用工具或技能。</p>
      <div className="ez-tree-actions"><button disabled={waiting || !state?.installed} onClick={() => act('prepareMcp')}>准备 MCP</button><button disabled={waiting || !state} onClick={() => act('installSkill')}>安装内置技能</button></div>
      {config && <details open><summary>MCP 配置</summary><pre>{JSON.stringify({ mcpServers: { 'ez-tree': config } }, null, 2)}</pre></details>}
    </section>
    {(error || state?.error) && <p role="alert">{error || state.error}</p>}
    {notice && <p role="status">{notice}</p>}
    <footer className="ez-tree-muted">基于 Daniel Greenheck 的 EZ-Tree，遵循 MIT 许可证。独立应用与插件统一维护，资源随发行包离线提供。</footer>
  </main>
}

export function apply(ctx) {
  ctx.effect(() => {
    const element = document.createElement('style')
    element.dataset.plugin = 'dsh-ez-tree'
    element.textContent = styles
    document.head.append(element)
    return () => element.remove()
  }, 'dsh-ez-tree: styles')
  const api = async action => {
    const result = await ctx.connection.rpc.call('/dsh-ez-tree', action, {})
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  function Panel() { return <EzTreePanel api={api} /> }
  let disposed = false
  let nativeReleases = []
  const releaseNative = () => { nativeReleases.forEach(release => release?.()); nativeReleases = [] }
  const registerNative = () => {
    nativeReleases = [
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-ez-tree' }, Panel)),
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-ez-tree', label: '树木生成器', order: 116 }, TreeIcon)),
    ]
  }
  ctx.effect(() => { registerNative(); return () => { disposed = true; releaseNative() } }, 'dsh-ez-tree: native navigation')
  ctx.inject?.(['sealHarnessNavigation'], inner => inner.effect(() => {
    // Seal 导航会自行注册 main；先释放原生入口，避免同 key 重复注册。
    releaseNative()
    const release = inner.sealHarnessNavigation.register({ id: 'dsh-ez-tree', label: '树木生成器', icon: 'models', order: 116, primary: true, Panel })
    return () => { release(); if (!disposed) registerNative() }
  }, 'dsh-ez-tree: navigation'))
}
