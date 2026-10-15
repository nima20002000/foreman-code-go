import { Validator } from '@cfworker/json-schema'
import { z } from 'zod'
import { IdSchema } from '../schemaPrimitives.js'

/** Output schema dialect: JSON Schema draft 2020-12 validated by @cfworker/json-schema. Remote
 * `$ref` is refused; local `#...` refs are allowed. Reference markers are plain keywords that the
 * validator ignores. Without a schema the default rule applies: the deliverable is present (not null or blank text). */
export const OUTPUT_SCHEMA_MAX_BYTES = 16 * 1024
export const OUTPUT_REFERENCE_KEYWORD = 'x-foreman-reference'
export const OUTPUT_REFERENCE_KINDS = ['ciTicket'] as const
export type OutputReferenceKind = (typeof OUTPUT_REFERENCE_KINDS)[number]
export const OUTPUT_MISMATCH_CODE = 'OUTPUT_SCHEMA_MISMATCH'
export const OUTPUT_REFERENCE_UNKNOWN_CODE = 'OUTPUT_REFERENCE_UNKNOWN'

export type OutputSchema = Record<string, unknown>
export type DeliverableIssue = { code: typeof OUTPUT_MISMATCH_CODE | typeof OUTPUT_REFERENCE_UNKNOWN_CODE; path: string; message: string }
export type DeliverableReference = { kind: OutputReferenceKind; value: string; path: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function schemaProblems(node: unknown, path: (string | number)[], problems: { path: (string | number)[]; message: string }[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => schemaProblems(item, [...path, index], problems))
    return
  }
  if (!isObject(node)) return
  if ('$ref' in node && (typeof node.$ref !== 'string' || !node.$ref.startsWith('#'))) {
    problems.push({ path: [...path, '$ref'], message: 'only local $ref values (starting with #) are allowed' })
  }
  if (OUTPUT_REFERENCE_KEYWORD in node) {
    if (!OUTPUT_REFERENCE_KINDS.includes(node[OUTPUT_REFERENCE_KEYWORD] as OutputReferenceKind)) {
      problems.push({ path: [...path, OUTPUT_REFERENCE_KEYWORD], message: `reference kind must be one of ${OUTPUT_REFERENCE_KINDS.join(', ')}` })
    }
    if (node.type !== 'string') problems.push({ path: [...path, OUTPUT_REFERENCE_KEYWORD], message: 'a reference marker requires type "string"' })
  }
  for (const [key, value] of Object.entries(node)) schemaProblems(value, [...path, key], problems)
}

export const OutputSchemaSchema = z.record(z.string(), z.json()).superRefine((schema, context) => {
  if (new TextEncoder().encode(JSON.stringify(schema)).length > OUTPUT_SCHEMA_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: `output schema exceeds ${OUTPUT_SCHEMA_MAX_BYTES} bytes` })
    return
  }
  const problems: { path: (string | number)[]; message: string }[] = []
  schemaProblems(schema, [], problems)
  for (const problem of problems) context.addIssue({ code: 'custom', path: problem.path.map(String), message: problem.message })
}) as unknown as z.ZodType<OutputSchema>

/** Skill overrides for one workflow Agent node. add pins exact workspace skill versions, like an Agent's
 * assignedSkills; remove names skills the Agent assigns. Both resolve into each execution's instructions. */
export const NodeSkillOverrideSchema = z.object({
  add: z.array(z.object({ skillId: IdSchema, version: z.string().trim().min(1) }).strict()).max(32).optional(),
  remove: z.array(IdSchema).max(32).optional(),
}).strict().superRefine((override, context) => {
  const added = (override.add ?? []).map(skill => skill.skillId)
  if (new Set(added).size !== added.length) context.addIssue({ code: 'custom', path: ['add'], message: 'add each skill once' })
  for (const skillId of added) {
    if (override.remove?.includes(skillId)) context.addIssue({ code: 'custom', path: ['add'], message: `skill ${skillId} cannot be both added and removed` })
  }
})
export type NodeSkillOverride = z.infer<typeof NodeSkillOverrideSchema>

/** Shape check for a deliverable: present (not null or blank text), then the declared schema when there is one. */
export function checkDeliverable(deliverable: unknown, outputSchema: OutputSchema | undefined): DeliverableIssue[] {
  if (deliverable === null || deliverable === undefined || (typeof deliverable === 'string' && deliverable.trim() === '')) {
    return [{ code: OUTPUT_MISMATCH_CODE, path: '', message: 'The deliverable is empty.' }]
  }
  if (!outputSchema) return []
  const result = new Validator(structuredClone(outputSchema) as never, '2020-12', false).validate(deliverable)
  if (result.valid) return []
  return result.errors.map(error => {
    const base = error.instanceLocation.replace(/^#/, '')
    // A missing property is reported on its parent object; name the property so the path is exact.
    const missing = error.keyword === 'required' ? /required property "(.+)"\.$/.exec(error.error)?.[1] : undefined
    const path = missing === undefined ? base : `${base}/${missing.replace(/~/g, '~0').replace(/\//g, '~1')}`
    return { code: OUTPUT_MISMATCH_CODE, path, message: `${error.keyword} at ${path || '/'}: ${error.error}` }
  })
}

/** Reference values marked in the schema, followed through properties and array items. */
export function deliverableReferences(outputSchema: OutputSchema | undefined, deliverable: unknown): DeliverableReference[] {
  const found: DeliverableReference[] = []
  const walk = (schema: unknown, value: unknown, path: string): void => {
    if (!isObject(schema)) return
    const kind = schema[OUTPUT_REFERENCE_KEYWORD]
    if (typeof kind === 'string' && typeof value === 'string') found.push({ kind: kind as OutputReferenceKind, value, path })
    if (isObject(schema.properties) && isObject(value)) {
      for (const [key, child] of Object.entries(schema.properties)) if (key in value) walk(child, value[key], `${path}/${key}`)
    }
    if (isObject(schema.items) && Array.isArray(value)) value.forEach((item, index) => walk(schema.items, item, `${path}/${index}`))
  }
  if (outputSchema) walk(outputSchema, deliverable, '')
  return found
}
