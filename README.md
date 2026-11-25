# dsh-ez-tree

在当前 DSH / Seal 会话中按需打开真实三维树木编辑器。安装并启用插件后即可使用内置 `ez-tree` 技能；不增加一级导航入口，不需要先去管理页安装独立应用或配置 MCP。

## 使用

1. 从 [Releases](https://github.com/asun-labs/dsh-ez-tree/releases) 下载当前版本 `dsh-ez-tree-*.tgz`，通过宿主插件管理安装并启用。
2. 在一个会话中调用 `/ez-tree`，或让智能体“使用 EZ-Tree 生成一棵松树”。
3. 技能指导智能体调用原生工具，在宿主现有的右侧浏览器中加载三维编辑器。实际模型就绪后，工具才返回渲染成功。
4. 直接旋转、缩放和调整参数，或继续让智能体修改。双方操作同一个会话项目，保留一致的 seed 和修订号。
5. 导出 GLB、透明 PNG 或参数 JSON。文件保存到当前会话工作目录的 `models/ez-tree`，不覆盖已有文件。

首次使用会加载随插件交付的编辑器、纹理和本地 Draco 解码器。页面由插件在本机启动的专用服务提供，无需额外安装或启动程序。右侧浏览器较窄时参数面板可收起，三维视口保持可见。宿主自身的登录、模型配置与工具权限仍由宿主管理。

## 能力与状态

包含 15 个树木预设、真实 WebGL 场景、枝干与树皮/叶片参数、环境和镜头控制、JSON 导入，以及带纹理 GLB、透明 PNG 和裸 TreeOptions JSON 导出。相同参数和 seed 可以复现树形。

项目按账号和会话隔离。切换会话不会把后台任务的面板打开到另一个会话；修订冲突保留最新项目，渲染失败不提交新参数。关闭面板后可再次调用技能恢复项目。工作目录变化后需要重新打开编辑器，避免向旧目录写文件。

插件提供这些原生会话工具：

- `ez_tree_open_editor`：打开并恢复当前会话编辑器，等待真实渲染。
- `ez_tree_editor_get`：读取当前已提交项目和参数。
- `ez_tree_editor_generate`：合并参数并等待同一面板渲染确认。
- `ez_tree_editor_export`：导出当前项目，返回实际路径、修订号和 SHA-256。

内置技能通过宿主原生技能 Provider 发现，不另复制一份到用户数据库。旧版由本插件原样创建的托管技能副本只有内容摘要完全匹配时才停用并保留，以避免遮蔽新技能；用户自定义内容不会被覆盖。

## 升级与已有数据

正式包名为 `dsh-ez-tree`。旧 `@asun-labs/dsh-ez-tree` 安装请使用随包迁移工具，见 [升级说明](docs/upgrade.md)。应用 ID、Cordis entry、已有 MCP 工具名和技能名、账号数据目录保持不变，原项目与导出不删除。

新会话编辑器不依赖独立桌面运行时。此前独立桌面/MCP 形态作为兼容方式保留，见 [外部 MCP 说明](docs/mcp.md) 和 [运行时兼容](docs/runtime-upgrade.md)；它不是新会话流程的前置步骤。已有外部 MCP 独立进程不会暗中冒充当前会话可见面板的状态。

## 开发与验证

使用 Node `^22.19.0 || >=24.0.0`、npm；真实宿主测试还需满足所选 DSH 版本的 Node 要求。

```sh
npm ci
npm run check
npm run build
npm run pack:release
```

图形启动必须显式执行。测试使用独立 Home 和隐藏窗口，不占用用户焦点。包内包含预编译 Host、客户端和完整编辑器资源，安装不编译；源代码和构建产物分别管理。真实宿主验收与已知平台范围见 [验证记录](docs/validation.md)，不能用网页测试替代实际桌面路径。

工程契约见 [docs/contracts.md](docs/contracts.md)。旧版程序的独立构建入口继续保留，日常会话无需执行。

## 来源与许可

基于 Daniel Greenheck 的 [EZ-Tree](https://github.com/dgreenheck/ez-tree)，固定 [ASunYC/ez-tree 提交](https://github.com/ASunYC/ez-tree/tree/135ac2bf85875eacf5637d18062e690cf16a1837)。86 个上游文件保留原字节和逐项哈希；MIT、Draco Apache 2.0 及实际依赖许可随包交付。见 `NOTICE`、`licenses/` 和 `vendor/ez-tree/provenance.json`。

npm 是否可安装以实际发布状态为准；GitHub Release 不代表已经发布到 npm。
