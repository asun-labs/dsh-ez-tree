# dsh-ez-tree

一个仓库交付完整 EZ-Tree 桌面编辑器、Seal / DeepSeek Harness 插件、MCP 和内置技能。

编辑器包含 15 个树木预设、实时三维预览、树皮与枝叶参数、环境与镜头控制、JSON 参数导入导出，以及带纹理的 GLB 模型和透明 PNG 导出。生成库、纹理、场景和 Draco 解码器随桌面程序交付，运行不依赖开发目录或另装 Node.js。

## 安装

从 [GitHub Releases](https://github.com/asun-labs/dsh-ez-tree/releases) 下载同一版本的插件 `.tgz`。在 Seal 的插件管理中导入这个完整包，启用后进入「树木生成器」。选择「安装桌面应用」，插件会下载固定版本的桌面包，校验压缩包及每个安装文件的 SHA-256，再安装到当前账号的数据目录。

也可以单独下载桌面 `.zip`，解压后运行 `EZ-Tree.exe` 使用完整编辑器。桌面压缩包内含许可证和运行时；保留整个目录，不要只复制 exe。

首版 Windows x64 交付流程由 `docs/validation.md` 记录。未列入插件受信清单的平台不会显示为可安装。Windows 发布物未进行代码签名。

## 在 Seal 会话中使用

1. 安装桌面应用后点击「准备 MCP」，创建当前账号独立、默认停用的连接器。
2. 到连接器页启用 EZ-Tree，并为需要的会话选择能力。
3. 点击「安装内置技能」，再到技能页按需启用 `ez-tree`。
4. 在会话中描述树木形态。智能体使用真实生成引擎，导出 GLB、PNG 或 JSON，返回文件路径、大小和校验值。

插件不自动把 MCP 或技能授予所有会话。原生 DSH 没有 Seal 管理服务时，面板给出 MCP 配置和随包技能目录，由用户在原生管理页面导入。

MCP 和打开的编辑器拥有各自的树木状态。通过参数 JSON 在两者之间传递项目；MCP 不会暗中操纵另一编辑器窗口。MCP 导出默认写入当前账号的 `exports` 目录，不覆盖已有文件。详细接口见 [MCP 使用说明](docs/mcp.md)。

## 数据与生命周期

默认根目录为 `DSH_HOME`，未设置时使用 `~/.seal-harness`。Seal 账号数据和受校验程序位于 `ez-tree/accounts/<账号哈希>/`；原生 DSH 使用独立的本机 owner 身份。程序文件、项目和导出分开存放。切换账号或卸载插件会停止由插件管理的编辑器实例；不会终止用户另外打开的程序。

卸载应用只删除受管理的程序目录，保留项目与导出文件。已启用的 MCP 需先在连接器页停用。下载、校验或安装失败不会把半成品标记为已安装；替换失败恢复旧版。

## 开发和验证

使用 Node `^22.19.0 || >=24.0.0`、npm 和 Python 3：

```sh
npm ci
npm run check
npm run desktop:dev
npm run desktop:pack
npm run verify:desktop -- "dist/unpacked/win-unpacked/EZ-Tree.exe"
npm run pack:release
```

`desktop:dev` 显式打开图形界面。自动验收隐藏窗口，不占用用户鼠标键盘或焦点。打包先验证独立运行时真实生成和导出，通过后才写入受信发布清单。插件包为预编译载荷，不含开发依赖，也不在用户机器上编译。

```text
app/                 完整编辑器适配和浏览器引擎桥
desktop/             独立桌面宿主、项目与导出
mcp/                 stdio 服务和参数校验
plugin/              Seal/DSH 安装、启动与界面接入
skills/ez-tree/      内置技能
vendor/ez-tree/      固定上游源码、资源与逐文件来源校验
releases/runtime.json  与插件版本绑定的受信桌面清单
```

发布包和 SHA-256 在 GitHub Release 分发。npm 是否可安装以实际 npm 发布状态为准；仅存在源码或 Release 不等同于已发布 npm。

## 来源与许可

基于 Daniel Greenheck 的 [EZ-Tree](https://github.com/dgreenheck/ez-tree)，固定 [ASunYC/ez-tree 提交](https://github.com/ASunYC/ez-tree/tree/135ac2bf85875eacf5637d18062e690cf16a1837)。保留上游 MIT 许可、作者归属和来源哈希。Draco 使用 Apache 2.0；其他依赖的许可证随发布物保留。详见 `NOTICE`、`licenses/` 及 `vendor/ez-tree/provenance.json`。
