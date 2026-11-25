import { z } from 'zod'
import { enums, numberRange } from '../app/options.js'
export { mergeOptions, checkComplexity as validateComplexity } from '../app/options.js'

function numeric(path) {
  const [minimum, maximum, step] = numberRange(path)
  const schema = z.number().finite().min(minimum).max(maximum)
  return step === 1 ? schema.int() : schema
}

function levels(path, keys = ['0', '1', '2', '3']) {
  return z.object(Object.fromEntries(keys.map(key => [key, numeric(`${path}.${key}`).optional()]))).strict()
}

// MCP 的外部结构校验与编辑器共用字段范围和生成规模契约。
export const optionsSchema = z.object({
  seed: numeric('seed').optional(),
  type: z.enum(enums.type).optional(),
  bark: z.object({
    type: z.enum(enums['bark.type']).optional(),
    tint: numeric('bark.tint').optional(), flatShading: z.boolean().optional(), textured: z.boolean().optional(),
    textureScale: z.object({ x: numeric('bark.textureScale.x').optional(), y: numeric('bark.textureScale.y').optional() }).strict().optional(),
  }).strict().optional(),
  branch: z.object({
    levels: numeric('branch.levels').optional(),
    angle: levels('branch.angle', ['1', '2', '3']).optional(),
    children: levels('branch.children', ['0', '1', '2']).optional(),
    force: z.object({
      direction: z.object(Object.fromEntries(['x', 'y', 'z'].map(key => [key, numeric(`branch.force.direction.${key}`).optional()]))).strict().optional(),
      strength: numeric('branch.force.strength').optional(),
    }).strict().optional(),
    gnarliness: levels('branch.gnarliness').optional(),
    length: levels('branch.length').optional(), radius: levels('branch.radius').optional(),
    sections: levels('branch.sections').optional(), segments: levels('branch.segments').optional(),
    start: levels('branch.start', ['1', '2', '3']).optional(), taper: levels('branch.taper').optional(),
    twist: levels('branch.twist').optional(),
  }).strict().optional(),
  leaves: z.object({
    type: z.enum(enums['leaves.type']).optional(),
    billboard: z.enum(enums['leaves.billboard']).optional(),
    ...Object.fromEntries(['angle', 'count', 'start', 'size', 'sizeVariance', 'tint', 'alphaTest'].map(key => [key, numeric(`leaves.${key}`).optional()])),
  }).strict().optional(),
}).strict()
