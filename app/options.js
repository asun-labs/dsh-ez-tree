const enums = { type: ['deciduous', 'evergreen'], 'bark.type': ['birch', 'oak', 'pine', 'willow'], 'leaves.type': ['ash', 'aspen', 'pine', 'oak'], 'leaves.billboard': ['single', 'double'] }

export function numberRange(path) {
  if (path === 'seed') return [0, 2147483647, 1]
  if (path.endsWith('.tint')) return [0, 0xffffff, 1]
  if (path === 'branch.levels') return [0, 3, 1]
  if (path.startsWith('branch.children.')) return [0, path.endsWith('.0') ? 100 : path.endsWith('.1') ? 10 : 5, 1]
  if (path.startsWith('branch.sections.')) return [1, 20, 1]
  if (path.startsWith('branch.segments.')) return [3, 16, 1]
  if (path.startsWith('branch.angle.')) return [0, 180]
  if (path.startsWith('branch.gnarliness.')) return [-0.5, 0.5]
  if (path.startsWith('branch.length.')) return [0.1, 100]
  if (path.startsWith('branch.radius.')) return [0.01, 5]
  if (path.startsWith('branch.start.') || path.startsWith('branch.taper.')) return [0, 1]
  if (path.startsWith('branch.twist.')) return [-0.5, 0.5]
  if (path === 'branch.force.strength') return [-0.1, 0.1]
  if (path.startsWith('branch.force.direction.')) return [-1, 1]
  if (path.startsWith('bark.textureScale.')) return [0.5, 10]
  if (path === 'leaves.angle') return [0, 100]
  if (path === 'leaves.count') return [0, 100, 1]
  if (path === 'leaves.size') return [0, 10]
  return [0, 1]
}

export function mergeOptions(template, patch, prefix = '') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(`${prefix || 'options'} 必须是参数对象。`)
  const result = structuredClone(template)
  for (const key of Object.keys(patch)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (!Object.hasOwn(template, key)) throw new Error(`未知参数：${path}`)
    const value = patch[key]
    if (typeof template[key] === 'object' && template[key] !== null) result[key] = mergeOptions(template[key], value, path)
    else if (enums[path]) {
      if (!enums[path].includes(value)) throw new Error(`${path} 不是有效选项。`)
      result[key] = value
    } else if (typeof template[key] === 'number') {
      const [min, max, step] = numberRange(path)
      if (!Number.isFinite(value) || value < min || value > max || (step === 1 && !Number.isInteger(value))) throw new Error(`${path} 必须在 ${min} 到 ${max} 之间${step === 1 ? '且为整数' : ''}。`)
      result[key] = value
    } else if (typeof value !== typeof template[key]) throw new Error(`${path} 的类型无效。`)
    else result[key] = value
  }
  return result
}

export function checkComplexity(options) {
  let branches = 1
  let vertices = 0
  for (let i = 0; i <= options.branch.levels; i++) {
    vertices += branches * (options.branch.sections[i] + 1) * (options.branch.segments[i] + 1)
    if (i === options.branch.levels) vertices += branches * options.leaves.count * 8
    branches *= Math.max(1, options.branch.children[i] ?? 1) + 1
  }
  if (!Number.isFinite(vertices) || vertices > 2_000_000) throw new Error('树木复杂度过高，请减少分枝、叶片或截面数量（预计超过 200 万顶点）。')
  return vertices
}

export { enums }
