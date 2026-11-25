import { mergeOptions, checkComplexity } from './options.js'

const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

export async function actualOptionsDigest(options) {
  if (!globalThis.crypto?.subtle?.digest) throw new Error('当前编辑器环境无法执行安全参数校验，请重新打开受信编辑面板。')
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(options)))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

export async function verifyProjectOptions(project, actualOptions) {
  const digest = await actualOptionsDigest(actualOptions)
  if (digest !== project.optionsDigest) throw new Error('实际树木参数与会话项目摘要不一致，已拒绝确认或导出。')
  return digest
}

function requireComplete(template, value, path = 'options') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是完整参数对象。`)
  for (const [key, example] of Object.entries(template)) {
    if (!Object.hasOwn(value, key)) throw new Error(`项目缺少参数：${path}.${key}`)
    if (example && typeof example === 'object') requireComplete(example, value[key], `${path}.${key}`)
  }
}

export function validateProject(project, current, template) {
  if (!project || typeof project !== 'object' || Array.isArray(project)
    || typeof project.projectId !== 'string' || !project.projectId || project.projectId.length > 200
    || !Number.isSafeInteger(project.revision) || project.revision < 0
    || typeof project.optionsDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(project.optionsDigest)
    || (project.force !== undefined && typeof project.force !== 'boolean')) throw new Error('项目快照无效。')
  if (current && project.projectId !== current.projectId) throw new Error('项目与当前编辑器会话不匹配。')
  if (current && !project.force && (project.revision < current.revision
    || (project.revision === current.revision && project.optionsDigest !== current.optionsDigest))) throw new Error('项目修订已过期，请刷新当前会话。')
  requireComplete(template, project.options)
  const options = mergeOptions(template, project.options)
  checkComplexity(options)
  const { force, ...snapshot } = project
  return { ...structuredClone(snapshot), options }
}

export function optionChanges(current, next) {
  const patch = {}
  for (const [key, value] of Object.entries(next)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = optionChanges(current[key] ?? {}, value)
      if (Object.keys(nested).length) patch[key] = nested
    } else if (value !== current[key]) patch[key] = value
  }
  return patch
}
