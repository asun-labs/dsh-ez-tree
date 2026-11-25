# 从 scoped 包迁移到 dsh-ez-tree

从 0.1.1 起，正式 npm/DSH 安装身份统一为 `dsh-ez-tree`。原包 `@asun-labs/dsh-ez-tree@0.1.0` 不再用于新安装；不能把两个包同时加入同一 Profile，以免重复声明相同插件 entry。

## 升级前

1. 下载 0.1.1 Release 的 `dsh-ez-tree-0.1.1.tgz`，核对随 Release 提供的 SHA256。
2. 完整退出要升级的 Seal 或原生 DSH Host，包括后台/托盘实例；暂时不要运行其他插件管理命令。关闭 EZ-Tree 编辑器和该 Home 启动的 MCP。
3. 明确需要升级的 `DSH_HOME`、Profile 名称及该安装自带的官方 DSH CLI `lib/bin.js` 路径。工具要求这三个位置显式给出，不会猜测生产目录。

解压插件 tgz 到临时目录，然后用符合所选官方 DSH CLI 要求的 Node 执行其中的 `package/lib/upgrade-profile.mjs`。本次验证使用 Node 24.x；官方 DSH 0.2.2-rc.3 CLI 要求 Node >=24.9.0：

```powershell
node ./package/lib/upgrade-profile.mjs `
  --home C:/Users/me/.seal-harness `
  --profile desktop `
  --cli C:/DSH/node_modules/@deepseek-ai/dsh/lib/bin.js `
  --package ./dsh-ez-tree-0.1.1.tgz `
  --host-stopped
```

`--host-stopped` 表示你已退出这个 Home 的 Host；工具不替你强制结束任何正在运行的应用。开发仓库中也可运行 `node scripts/upgrade-profile.mjs`，参数相同。`--help` 显示可复制示例。

## 工具会做什么

- 只接受身份为 `dsh-ez-tree@0.1.1`、声明 DSH bundle 的 tgz；通过现有安装提供的官方 `runCli({ manageDesktopProfile: true })` 安装，不自行模拟包管理器。
- 使用专用迁移锁及官方文件写锁，先备份 Profile manifest、锁文件、workspace 配置、Cordis 配置和兼容授权记录，以及 Home 级 `cordis.patch.yml`。原依赖来源写入备份；本地旧 tgz 来源仍存在时，也保留一份。
- 安装新包之前移除旧依赖和旧 bundle 选择。新安装成功后，在原 bundle 位置恢复 canonical 名称，并清理本产品的重复 bundle；无关依赖、bundle 顺序和 Profile 字段保留。
- 旧 bundle 原本未选中时，新 bundle 仍不选中。原生插件开关使用 entry ID 与可选的模块名称限定；工具只更新 `id: dsh-ez-tree` 的旧名称限定，保留 `disabled`、配置、注释及 `!!js` 表达式，不执行表达式。
- 顶层独立 `insert` 若会与新 bundle 重复，转换为同一 entry 的 override，保留后续覆盖顺序。未知自定义 entry ID 或分组中的独立 entry 会在修改前拒绝，避免猜测用户的组合意图。
- 成功后返回 JSON，包含版本、实际 tgz SHA256、备份位置和最终 bundle 启停状态。对已完成迁移的 Profile 重复执行不会再次安装或覆盖配置。

备份位于 `<DSH_HOME>/profiles/<profile>/.ez-tree-upgrades/<时间戳与随机标识>/`，包含恢复清单及原文件。不要随意删除刚完成升级的备份。

## 保留的数据与历史

Cordis entry ID 仍为 `dsh-ez-tree`，桌面 appId、RPC、MCP 工具名、确定性的账号连接器 ID、技能名和 `ez-tree/accounts/<账号哈希>` 数据目录保持不变；不移动或删除项目、GLB、PNG、参数 JSON，也不自动启用 MCP/技能。

原 MCP 连接器可能仍指向 0.1.0 的运行时。先安装新版桌面程序，再在插件中点击“准备 MCP”，更新固定启动配置；按需重新启用连接器。旧运行时路径保留供已有配置使用，确认迁移完毕后再自行清理。

`.cordis/resolve.mjs` 是原生运行时生成的解析器；下次启动会依当前 Profile 重新生成，不保存插件开关。`.plugin-manager` 中的操作日志不改名。Seal 的健康恢复检查点是历史快照，不会被此工具重写；新版本成功启动后由宿主生成新的健康快照。若主动恢复升级前的快照，旧包名回归是正常的，需要再次执行迁移。`compatibility.json` 的授权精确绑定原包和版本，不会被自动扩大到新身份。

## 失败恢复

迁移失败时，工具先逐字节恢复原配置和锁文件，再调用官方安装器按旧锁离线恢复依赖。错误会明确指出恢复成功或恢复失败，并保留备份位置。

若依赖恢复也失败，保持 Host 关闭。根据备份 `manifest.json` 里的文件清单恢复文件，在该 Home 下使用官方 CLI 运行 `dsh plugin --profile <profile> install --frozen-lockfile --ignore-scripts`；网络不可用且旧本地来源丢失时，可使用备份中的 `legacy-source.tgz` 重新安装旧包。不要只恢复 `package.json` 就假定 `node_modules` 已恢复。确认旧版可启动或迁移重新成功后，再启动 Host。

升级验收应检查：Profile 中只有一个 canonical 依赖/bundle、原开关状态保留、原项目仍存在、真实插件 Host/Client 可加载。构建成功或单独修改依赖名称不能替代这些检查。
