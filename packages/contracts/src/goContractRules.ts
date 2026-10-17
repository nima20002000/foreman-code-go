import { z } from 'zod'

/** Declarative rules consumed by both the TS validator and Go schema export. */
export type GoContractNormalizationRule = Readonly<{ kind: 'trim' }>
export type GoContractConditionalPresenceRule = Readonly<{
  kind: 'conditionalPresence'
  discriminator: string
  equals: string
  field: string
  presence: 'truthy'
  requiredMessage: string
  forbiddenMessage: string
}>
export type GoContractRule = GoContractNormalizationRule | GoContractConditionalPresenceRule

const checkRules = new WeakMap<object, GoContractRule>()

/** Exporters use exact check identities; arbitrary .meta() claims are not proof. */
export function goContractRuleForCheck(check: object): GoContractRule | undefined {
  return checkRules.get(check)
}

function registerCheck(before: z.ZodType, after: z.ZodType, rule: GoContractRule): void {
  const previous = before._zod.def.checks ?? []
  const current = after._zod.def.checks ?? []
  const added = current[previous.length]
  if (current.length !== previous.length + 1 || !added ||
      previous.some((check, index) => current[index] !== check)) {
    throw new Error('Shared contract rule did not append exactly one Zod check')
  }
  checkRules.set(added, rule)
}

/** Apply declared normalizers before the caller's ordinary string constraints. */
export function normalizedString(
  normalization: readonly GoContractNormalizationRule[],
  finish: (schema: z.ZodString) => z.ZodString,
): z.ZodString {
  const rules = Object.freeze(normalization.map(rule => Object.freeze({ ...rule })))
  let schema = z.string()
  for (const rule of rules) {
    const before = schema
    switch (rule.kind) {
      case 'trim': schema = schema.trim(); break
      default: throw new Error('Unsupported shared string normalization rule')
    }
    registerCheck(before, schema, rule)
  }
  return finish(schema).meta({ foremanGo: { version: 1, normalization: rules } })
}

/** Preserve the source's post-parse JavaScript truthiness and custom issues. */
export function withConditionalPresence<T extends z.ZodObject>(
  schema: T,
  refinements: readonly GoContractConditionalPresenceRule[],
): T {
  const rules = Object.freeze(refinements.map(rule => Object.freeze({ ...rule })))
  let result = schema
  for (const rule of rules) {
    if (rule.kind !== 'conditionalPresence' || rule.presence !== 'truthy') {
      throw new Error('Unsupported shared conditional presence rule')
    }
    const before = result
    result = result.superRefine((value, context) => {
      const selected = value[rule.discriminator] === rule.equals
      const present = Boolean(value[rule.field])
      if (selected && !present) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [rule.field], message: rule.requiredMessage })
      }
      if (!selected && present) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [rule.field], message: rule.forbiddenMessage })
      }
    })
    registerCheck(before, result, rule)
  }
  return result.meta({ foremanGo: { version: 1, refinements: rules } })
}
