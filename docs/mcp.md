# 可选外部 MCP 与独立编辑器

日常 DSH/Seal 会话请直接使用内置 `ez-tree` 技能和 `ez_tree_editor_*` 原生工具，不需要执行本文的连接器设置。本文保留既有独立进程的兼容接口，它不会自动同步当前会话的可见编辑面板。

独立发布物中的 Electron 内嵌 Node 运行时执行 MCP 启动器，再启动受控的隐藏渲染器。连接器不需要系统 Node、开发 checkout 或额外的 MCP 安装。安装应用不会自动授权会话调用。

```json
{
  "mcpServers": {
    "ez-tree": {
      "command": "D:/Apps/EZ Tree/EZ-Tree.exe",
      "args": ["D:/Apps/EZ Tree/resources/app/lib/mcp/cli.mjs", "--account", "my-account", "--output-dir", "D:/Models/Trees"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

路径应使用插件实际返回的受管理程序与 MCP 入口路径。示例路径只用于说明；不能直接照抄假设程序存在。Seal 插件返回的连接配置包含当前 `DSH_HOME` 和账号。`ELECTRON_RUN_AS_NODE` 只用于 MCP 连接器进程；隐藏渲染器由启动器自行创建，完整桌面编辑器正常启动。

工具：

- `ez_tree_list_presets`：列出实际预设名称。
- `ez_tree_get_parameters`：读取完整参数和导出目录。
- `ez_tree_generate`：使用预设和部分参数生成树木，返回实际顶点与三角形数量。
- `ez_tree_export`：导出 GLB、PNG 或 JSON，返回路径、字节数和 SHA-256。

标准流程为列出预设、生成、导出 JSON 项目及 GLB 模型，必要时附带 PNG。JSON 可在桌面编辑器继续打开修改。同一组参数和 seed 共用相同的上游生成引擎。

MCP 只在配置的输出目录创建文件，文件名不能包含路径，不覆盖已有文件。生成规模受限；正在运行的工具被取消时，此 MCP 实例及其隐藏渲染器退出，连接器可重新连接。MCP 模式不显示编辑器窗口，诊断只写 stderr，stdout 仅传输 MCP 消息。启动器与渲染器通过随机命名管道和单次令牌通信，不开放 HTTP 服务。

验收：设置 `EZ_TREE_EXECUTABLE` 为已打包的程序路径、`EZ_TREE_MCP_ENTRY` 为同一安装中的 `resources/app/lib/mcp/cli.mjs` 后运行 `node --test tests/mcp-stdio.test.mjs`。该测试使用官方 SDK 建立真实 stdio 会话，验证 15 个预设、实际生成、带纹理 GLB、PNG 和 JSON、路径与覆盖拒绝，以及同账号 GUI 和 MCP 并行运行。

## 参数示例

先调用 `ez_tree_list_presets`，使用返回的名称生成：

```json
{
  "preset": "Ash Small",
  "options": {
    "seed": 12345,
    "branch": { "children": { "0": 5 } },
    "leaves": { "count": 8, "size": 1.5 }
  }
}
```

这是 `ez_tree_generate` 的参数对象。`preset` 可省略，表示在当前树的基础上调整；`options` 为嵌套的部分参数，未提供字段保留预设或当前值。请使用 `ez_tree_get_parameters` 读取实际结构，不能猜测字段。无效预设、未知字段、越界值和过大的生成规模返回工具错误。

导出工具的参数示例为 `{"format":"glb","name":"ash-12345"}`。`format` 支持 `glb`、`png`、`json`；`name` 可省略，由程序生成唯一名称。返回值包含 `path`、`bytes`、`sha256`、`format`。可重复导出不同格式；同名文件已存在时应更换名称。

## 实例与编辑器状态

每个 MCP 连接器进程拥有自己的当前树。多个连接器实例之间，以及 MCP 与独立桌面窗口之间，不会实时同步当前编辑状态。它们共用相同生成代码和项目格式。将 MCP 结果带入编辑器时，导出 JSON，再在桌面窗口打开该项目；将手动编辑结果交给智能体时，保存 JSON 并让智能体读取参数后调用生成。

普通启动打开完整可视化编辑器；MCP 连接使用上面的内嵌 Node 启动器配置；`--verify <目录>` 运行真实引擎导出验收后退出；`--verify-ui <目录>` 额外加载完整编辑器、保存截图后退出。验收模式也不显示或聚焦窗口。

数据默认落在 `DSH_HOME`（未设置时为 `~/.seal-harness`）下的 `ez-tree/accounts/<账号摘要>/`；未指定账号时使用 `local`。默认导出目录为其中的 `exports`。用户项目与输出不写入安装目录。
