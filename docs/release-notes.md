# EZ-Tree 0.1.1

插件正式包名统一为 **`dsh-ez-tree`**，与 ChatChat 的命名格式一致。GitHub 仓库仍为 `asun-labs/dsh-ez-tree`。

- 更新安装包身份、Cordis bundle、客户端 Loader 和发行文件名。
- 随包提供旧名称迁移工具：将 `@asun-labs/dsh-ez-tree` 迁移为唯一的 `dsh-ez-tree` 条目，保留启用状态及配置；支持备份、失败恢复和重复执行。
- 保持应用 ID、Cordis entry、RPC、MCP 工具与连接器 ID、技能名及账号数据目录不变。
- 已校验的旧版桌面程序可继续运行，界面显示可升级版本。更新失败保留可用旧版；保留旧 MCP 可执行路径、项目和导出。
- 新旧运行时及实际插件升级分别验收。0.1.0 的已发布附件保留，不覆盖历史版本。

新安装请下载 `dsh-ez-tree-0.1.1.tgz`。已有旧名称安装时，先关闭宿主，使用包内 `lib/upgrade-profile.mjs` 按 [升级说明](https://github.com/asun-labs/dsh-ez-tree/blob/v0.1.1/docs/upgrade.md) 迁移，避免旧新条目同时激活。所有附件摘要见 `SHA256SUMS`。

完整编辑器、真实 GLB/PNG/JSON 导出、MCP stdio、并发、数据保留及插件迁移均须通过发行门禁。验证全程隐藏窗口，不占用鼠标键盘或焦点。

本次桌面发行包为 Windows x64，未进行代码签名。npm 发布以有效凭据和实际结果为准，不把 GitHub Release 当作 npm 发布。
