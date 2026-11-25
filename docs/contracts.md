# 产品工程契约

## 1. 范围与触发

修改独立应用、Seal 接入、MCP、技能、安装器或发行物时遵守本契约。业务由独立应用拥有；插件只负责接入。上游 vendor 原字节与来源哈希保持一致，适配写在 app/。

0.1.1 起包名统一为 `dsh-ez-tree`，历史包名 `@asun-labs/dsh-ez-tree` 只用于迁移识别。Loader 必须注册当前 package.name；Cordis entry `dsh-ez-tree`、应用 ID、账号目录、RPC、MCP 工具/连接器 ID 和技能名均保持稳定。旧 profile 迁移、回滚及幂等契约见 [upgrade.md](upgrade.md)。

## 2. 接口

- Host Connection RPC `/dsh-ez-tree`，action 为 `status/install/open/close/uninstall/prepareMcp/installSkill`，payload 固定空对象，只允许 owner principal。
- 返回 `{ok:true,value}` 或 `{ok:false,error:{code,message,details:{}}}`；应用就绪与进程已创建分别处理。
- MCP stdio 工具为 `ez_tree_list_presets/ez_tree_get_parameters/ez_tree_generate/ez_tree_export`。参数以 SDK 实际 schema 为准，生成与 UI 共享 `app/options.js` 验证规则。
- MCP 配置使用同包可执行程序，环境 `ELECTRON_RUN_AS_NODE=1`，参数为受校验的 `lib/mcp/cli.mjs` 绝对路径及 `--account <id> --output-dir <directory>`。启动器通过带随机令牌的本机管道调用隐藏渲染器；不依赖系统 Node。桌面 `--verify` 与 `--verify-ui` 是隐藏验收入口。

## 3. 数据、环境与发布

`DSH_HOME` 优先于 `~/.seal-harness`。账号目录为 `ez-tree/accounts/<sha256(accountId)[0:16]>`。运行时安装在此目录下 `runtime/<version>/<platform>-<arch>`，用户输出在 `exports`；普通卸载保留用户数据。

Seal 有身份服务时只接受已登录账号，并核对 accountId 与 epoch。服务缺席时原生 DSH 使用 `local-owner`，不能把 Seal 登出当成本机回退。账号切换中止任务并关闭插件拥有的编辑器进程。

受信 `releases/runtime.json` 包含 appId、版本、平台及固定 GitHub Release URL、字节数、压缩包 SHA256、可执行入口和逐文件清单。应用、插件、标签、发布清单版本一致。插件与桌面包分发预编译内容；同版本已发布附件不覆盖。

## 4. 错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| 非 owner、登出、账号变化 | 拒绝或中止，不展示旧账号配置 |
| 未验证平台 | 不提供猜测的可执行程序或安装包 |
| 下载/哈希失败、ZIP 路径越界或链接 | 拒绝安装，清理临时载荷 |
| 替换失败 | 恢复旧程序；恢复也失败时保留备份并报告实际位置 |
| 应用未就绪或版本/PID/程序身份不匹配 | 不报告运行可用 |
| MCP 仍启用时卸载 | 提示先停用，不修改无关连接器 |
| 导出同名文件 | MCP 拒绝覆盖；GUI 经系统保存对话框明确选择后可替换 |
| 无效参数或过高复杂度 | 在改变模型前拒绝 |

## 5. 基础、正常、错误案例

基础：独立解压桌面包后，无系统 Node 和开发目录仍可生成与导出。正常：安装插件、安装应用、准备停用的 MCP、用户选择会话后生成并导出带纹理 GLB。错误：账号切换后旧安装请求不得启动旧账号的程序，旧 MCP 配置不得留在页面。

## 6. 验证要求

`npm run check` 覆盖参数、15 个预设、路径与文件发布、owner/账号/epoch、连接器和技能默认停用、客户端轮询与配置清理、安装摘要与回滚。`verify:desktop` 对实际打包程序在隔离工作目录和空 PATH 下验证版本、真实 GLB/PNG/JSON、完整编辑器与真实 SDK MCP stdio。发布前额外验证已安装实例、关闭/重开、卸载保留数据及精确 tgz 的原生 DSH 安装。构建成功不能替代运行成功，Windows 通过不代表 macOS/Linux 通过。

## 7. 错误与正确

错误：运行旁边 ez-tree checkout 的 Vite 服务，只提交入口卡片便声称完成交付。正确：桌面发布物包含固定生成器和离线资源，插件安装经过摘要校验的程序，MCP 调用该程序，并用真实导出结果验收。

错误：插件安装时启用全部会话能力。正确：账号独立连接器和技能以停用状态安装，由用户在能力和会话页面选择。
