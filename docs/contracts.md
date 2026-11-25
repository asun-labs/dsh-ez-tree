# 会话编辑器工程契约

## 1. 范围与触发

主使用路径为安装启用插件 → 原生内置 ez-tree 技能 → 当前会话原生工具 → 按需三维右栏。不能用常驻管理页、静态预览或独立 MCP 的另一棵树代替真实会话编辑。独立应用与外部 MCP 是兼容方式。

## 2. 公开接口

- Host工具：ez_tree_open_editor / ez_tree_editor_get / ez_tree_editor_generate / ez_tree_editor_export。会话来自 exec.agent.id，目录来自 workingDirectory.ensure；不能由模型参数指定任意账号、会话或输出目录。
- bundled SkillProvider 提供 ez-tree，不要求手工复制到管理数据库。保留用户自定义优先级，只迁移原样匹配的旧托管副本。
- Client使用公开 mounted 订阅和 openTab('browser', {params:{url}})，复用宿主现有右侧浏览器；不注册自定义 sidebarRightTabs、main、sidebar.panellist 或 Seal 一级导航，不依赖私有 openTabIn。
- RPC /dsh-ez-tree/{editorWatch,editorRead,editorEdit,editorExport,editorAck,editorFail}；长轮询带游标、取消与账号指纹。保留旧管理RPC作为兼容，但新流程不依赖它。
- 两版内置浏览器均拒绝加载应用自身 origin。主流程通过插件专用的 127.0.0.1 随机端口加载编辑页，不放宽宿主导航策略。Owner RPC 只向可信客户端签发绑定账号、epoch、会话的页面地址；一次性短效 fragment 授权兑换每视图 HttpOnly、SameSite=Strict cookie，随后清除 fragment。视图 ID 本身不授权，页面不持有宿主通用凭据。
- 专用页面 API 只支持绑定项目的 read/watch/edit/export/ack/fail/upload，检查精确 Origin，不开放 CORS 或任意文件路径。二进制最高128MiB；普通 Owner RPC 保持16KiB上限。静态资源与上传共用有界业务函数，不伪造 Owner Peer，也不额外注册应用内部编辑页路由。

## 3. 状态与生命周期

Host ProjectStore 是唯一已提交状态，按账号与真实会话隔离，保存完整 TreeOptions、preset、seed、revision 和 optionsDigest。数据根为 DSH_HOME 或 ~/.seal-harness；原 ez-tree/accounts 路径、应用ID、工具/连接器/技能既有身份保持稳定。

工具与手动意图走同一项目队列。先发布待渲染command，得到实际网格统计和匹配摘要的ACK后，才原子提交修订。初次打开、工作目录变更也不能先提交再等ACK。渲染、保存或取消失败恢复原项目；未提交的状态不能作为导出成功结果。

右侧浏览器页面直接消费绑定项目的 watch/ACK；手动意图的等待不能阻塞渲染命令，否则会形成循环等待。旧 iframe MessageChannel 可作为兼容传输，但不能用新自定义布局替代宿主浏览器。账号变化及卸载撤销授权并取消等待；重新打开或刷新应恢复已提交项目，不能另造一棵随机树。

## 4. 验证与错误矩阵

| 情况 | 必须行为 |
| --- | --- |
| Native0.2.3已传入认证Peer | 使用已认证Peer，不重复访问受限connection.authentication |
| Sealrc3无第三Peer参数 | 使用原Connection准入，保留owner校验 |
| 参数未知/越界、过高复杂度 | 生成前拒绝，保留原模型 |
| 手动与工具修订冲突 | 拒绝陈旧覆盖，恢复当前已提交快照 |
| 面板未就绪、关闭或WebGL失败 | 不报告打开/生成成功，给出可重试错误 |
| 上传超限、格式不符、过期操作或取消 | 不发布文件，释放工具等待 |
| 会话工作目录变化 | 重新确认目录后再修改/导出，不能写旧目录 |
| 无权限/跨账号/旧epoch | 拒绝或中止，不向新账号回显旧项目 |

导出必须包含真实网格/图片。GLB校验资产版本与mesh，PNG校验尺寸与结束块；实际浏览器验收还必须检查彩色前景与透明背景，不能把黑色剪影或仅有文件头当成功。

## 5. 基础、正常、错误案例

基础：安装预编译TGZ后，原生技能可发现，页面没有常驻树木管理入口。正常：工具打开真实面板，AI设seed后手动调参，再用工具读取和导出同一修订。错误：收到合法desktop请求却重复admit导致认证注入异常，不能通过放宽JSON协议或伪造owner解决。

## 6. 必需验收

npm run check 检查共享状态/CAS/取消/权限/资源路由/包加载/参数边界。纯源码SDK测试不能代替提取TGZ后的隔离进程导入，也不能代替真实宿主。框架SDK的包版本元数据在构建时准确内联，并以唯一匹配断言防止上游漂移；不能补一个lib/package.json欺骗相对路径。

必须在实际Native0.2.3和Sealrc3承载路径检查技能发现、模型可见工具、原生会话身份、按需面板、实际canvas、手动与工具共享、二进制导出及切换/失败。普通HTTP浏览器集成必须单独标注，不能冒充桌面或真实模型调用。截图全黑或未取到图像不算视觉通过。

## 7. 错误与正确

错误：把管理按钮页和手工MCP设置当作技能编辑体验。正确：插件携带完整渲染资源，技能调用原生会话工具，真正打开当前项目面板。

错误：隐藏Skybox Mesh.visible后仍声称PNG正常。正确：仅屏蔽环境网格的渲染层，保留其子灯光，结束恢复；用真实导出像素验证彩色树木。
