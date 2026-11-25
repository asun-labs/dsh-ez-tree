import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { saveExport } from '../desktop/paths.mjs'
import { mergeOptions, optionsSchema, validateComplexity } from './options.mjs'

const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

export async function createMcpServer({ editor, outputDirectory, version, onClose }) {
  const server = new McpServer({ name: 'dsh-ez-tree', version }, { capabilities: { tools: {} } })
  let queue = Promise.resolve()
  const run = operation => async (args, extra) => {
    const pending = queue.then(async () => {
      extra?.signal?.throwIfAborted()
      const cancel = () => onClose?.()
      extra?.signal?.addEventListener('abort', cancel, { once: true })
      try {
        const value = await operation(args)
        extra?.signal?.throwIfAborted()
        return value
      } finally { extra?.signal?.removeEventListener('abort', cancel) }
    })
    queue = pending.catch(() => {})
    try { return content(await pending) }
    catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true } }
  }
  server.registerTool('ez_tree_list_presets', {
    description: '列出完整 EZ Tree 树木预设。生成前使用准确预设名称，避免猜测。', inputSchema: {},
  }, run(async () => ({ presets: await editor.call('listPresets') })))
  server.registerTool('ez_tree_get_parameters', {
    description: '读取当前树木的全部参数，可用于修改参数或保存项目。', inputSchema: {},
  }, run(async () => ({ options: await editor.call('getOptions'), outputDirectory })))
  server.registerTool('ez_tree_generate', {
    description: '使用预设或部分参数生成真实树木几何。与完整桌面编辑器共用生成引擎；调用 export 工具保存 GLB、PNG 或 JSON 项目。',
    inputSchema: { preset: z.string().min(1).max(80).optional(), options: optionsSchema.optional() },
  }, run(async ({ preset, options = {} }) => {
    const presets = await editor.call('listPresets')
    if (preset && !presets.includes(preset)) throw new Error('未知预设，请先调用 ez_tree_list_presets。')
    const base = await editor.call(preset ? 'getPresetOptions' : 'getOptions', preset)
    const merged = mergeOptions(base, options)
    validateComplexity(merged)
    return editor.call('setOptions', { options: merged })
  }))
  server.registerTool('ez_tree_export', {
    description: '将当前树木导出为真实 GLB 模型、PNG 预览或 JSON 参数项目，返回文件路径、字节数和 SHA-256。文件保存在启动时配置的输出目录；不会覆盖已有文件。',
    inputSchema: { format: z.enum(['glb', 'png', 'json']), name: z.string().min(1).max(80).optional() },
  }, run(async ({ format, name }) => {
    const result = await editor.call('exportFile', { format })
    return saveExport(outputDirectory, format, name, result.base64)
  }))
  const transport = new StdioServerTransport()
  transport.onclose = () => { onClose?.() }
  await server.connect(transport)
  return server
}
