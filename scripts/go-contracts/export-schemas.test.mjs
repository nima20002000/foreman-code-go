import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { exportContractSchemas, FROZEN_REFERENCE } from './export-schemas.mjs'
import { normalizedString, withConditionalPresence, goContractRuleForCheck } from '../../packages/contracts/dist/goContractRules.js'
import * as primitives from '../../packages/contracts/dist/schemaPrimitives.js'
import * as principals from '../../packages/contracts/dist/management/principals.js'

const { z } = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('zod')
const source = { reference: FROZEN_REFERENCE, purpose: 'public exporter test fixtures; not a capture receipt' }

function exported(schemas, names = Object.keys(schemas), options = {}) {
  return exportContractSchemas({ modules: new Map([['fixture', schemas]]),
    selected: names.map(name => `fixture#${name}`), source, ...options })
}

function schemaNodes(schema) {
  const nodes = []
  const pending = [schema]
  while (pending.length) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    nodes.push(current)
    for (const key of ['properties', 'patternProperties', '$defs', 'dependentSchemas']) {
      pending.push(...Object.values(current[key] ?? {}))
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) pending.push(...(current[key] ?? []))
    for (const key of ['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
      pending.push(current[key])
    }
  }
  return nodes
}

test('schema-export.coverage', () => {
  const result = exported({ FirstSchema: z.string(), SecondSchema: z.boolean(), helper: () => {} }, ['FirstSchema'])
  assert.deepEqual(result.coverage.counts, { discovered: 2, selected: 1, exported: 1, unsupported: 0, unselected: 1 })
  assert.deepEqual(result.coverage.discovered, ['fixture#FirstSchema', 'fixture#SecondSchema'])
  assert.deepEqual(result.coverage.unselected, ['fixture#SecondSchema'])
  assert.deepEqual(result.coverage.nonSchemaExports, ['fixture#helper'])
  assert.equal(result.coverage.scope, 'explicit-module-roots')
  assert.equal(result.source.reference, FROZEN_REFERENCE)
})

test('schema-export.input-output-presence', () => {
  const schema = z.strictObject({ required: z.string(), optional: z.string().optional(),
    nullable: z.string().nullable(), optionalNullable: z.string().nullable().optional() })
  const result = exported({ PresenceSchema: schema })
  assert.deepEqual(result.unsupported, [])
  const entry = result.schemas[0]
  assert.notEqual(entry.input, entry.output)
  for (const direction of ['input', 'output']) {
    const object = schemaNodes(entry[direction]).find(node => node.properties?.required)
    assert.deepEqual(new Set(object.required), new Set(['required', 'nullable']))
    assert.equal(object.additionalProperties, false)
    const nullable = object.properties.nullable
    assert.ok(nullable.type?.includes('null') || nullable.anyOf?.some(node => node.type === 'null'))
    assert.equal(object.properties.optional.type, 'string')
  }
  assert.equal(schema.safeParse({ required: 'x', nullable: null }).success, true)
  assert.equal(schema.safeParse({ required: 'x' }).success, false)
  assert.equal(schema.safeParse({ required: 'x', nullable: null, extra: true }).success, false)
})

test('schema-export.missing-and-nonschema', () => {
  const result = exported({ ValueSchema: z.number(), helper: () => {} }, ['ValueSchema', 'MissingSchema', 'helper'])
  assert.deepEqual(result.coverage.exported, ['fixture#ValueSchema'])
  assert.deepEqual(result.coverage.unsupported, ['fixture#MissingSchema', 'fixture#helper'])
  assert.ok(result.unsupported.every(entry => entry.issues[0].code === 'missing-schema-export'))
  assert.equal(result.coverage.counts.selected, 3)
})

test('schema-export.duplicate-identities', () => {
  assert.throws(() => exported({ ValueSchema: z.string() }, ['ValueSchema', 'ValueSchema']), /Duplicate selected/)
  assert.throws(() => exportContractSchemas({ modules: new Map(), selected: ['ValueSchema'], source }), /exact module#ExportSchema/)
  assert.throws(() => exportContractSchemas({ modules: new Map(), selected: ['fixture#ValueSchema#Other'], source }), /exact module#ExportSchema/)
})

test('schema-export.frozen-reference', () => {
  assert.throws(() => exported({ ValueSchema: z.string() }, undefined,
    { source: { reference: '0000000000000000000000000000000000000000' } }), /cannot be refreshed/)
})

test('schema-export.unsupported-runtime-behavior', () => {
  const result = exported({
    TrimSchema: z.string().trim().min(1),
    RefinedSchema: z.string().refine(value => value !== 'blocked'),
    TransformedSchema: z.string().transform(value => value.length),
    DefaultSchema: z.string().default('default'),
    CoercedSchema: z.coerce.string(),
    StripSchema: z.object({ id: z.string() }),
    FlaggedSchema: z.string().regex(/hello/i),
    URLSchema: z.url(),
    PlainSchema: z.strictObject({ id: z.string() }),
  })
  assert.deepEqual(result.coverage.exported, ['fixture#PlainSchema'])
  assert.equal(result.coverage.counts.unsupported, 8)
  assert.ok(result.unsupported.every(entry => entry.issues.length > 0))
  assert.equal(result.schemas.length + result.unsupported.length, result.coverage.counts.selected)
})

test('schema-export.forged-rule-metadata', () => {
  const rule = Object.freeze({ kind: 'trim' })
  const falselyLabeled = z.string().toUpperCase().meta({ foremanGo: { version: 1, normalization: [rule] } })
  const unregistered = exported({ ForgedSchema: falselyLabeled }, undefined, { ruleForCheck: goContractRuleForCheck })
  assert.equal(unregistered.schemas.length, 0)
  assert.ok(unregistered.unsupported[0].issues.some(problem => problem.code === 'unbound-runtime-check'))
  const real = normalizedString([{ kind: 'trim' }], schema => schema.min(1))
  const extra = exported({ ExtraSchema: real.refine(value => value !== 'blocked') }, undefined,
    { ruleForCheck: goContractRuleForCheck })
  assert.equal(extra.schemas.length, 0)
  assert.ok(extra.unsupported[0].issues.some(problem => problem.code === 'unbound-runtime-check'))
})

test('schema-export.shared-trim', () => {
  const result = exportContractSchemas({ modules: new Map([['.', primitives]]), selected: ['.#IdSchema'],
    source, ruleForCheck: goContractRuleForCheck,
    moduleRoots: [{ module: '.', file: 'dist/schemaPrimitives.js', sourceFile: 'src/schemaPrimitives.ts' }] })
  assert.deepEqual(result.unsupported, [])
  assert.equal(result.coverage.moduleRoots[0].file, 'dist/schemaPrimitives.js')
  for (const direction of ['input', 'output']) {
    const normalized = schemaNodes(result.schemas[0][direction]).find(node => node['x-foreman-normalization'])
    assert.deepEqual(normalized['x-foreman-normalization'], [{ kind: 'trim' }])
    assert.equal(normalized.minLength, 1)
  }
  assert.equal(primitives.IdSchema.parse(' \talpha\u00a0'), 'alpha')
  assert.equal(primitives.IdSchema.safeParse(' \t\u00a0').success, false)
  assert.equal(primitives.IdSchema.parse('\ud800'), '\ud800')
  assert.equal(result.validation.stringRepresentation, 'lossless-utf16')
  assert.equal(result.validation.stringLength, 'unicode-code-points')
})

test('schema-export.normalization-check-order', () => {
  const schema = normalizedString([{ kind: 'trim' }], value => value.min(1)).trim()
  const result = exported({ LaterTrimSchema: schema }, undefined, { ruleForCheck: goContractRuleForCheck })
  assert.equal(result.schemas.length, 0)
  assert.ok(result.unsupported[0].issues.some(problem => problem.code === 'unbound-runtime-check'))
})

test('schema-export.record-key-normalization', () => {
  const identifier = normalizedString([{ kind: 'trim' }], schema => schema.min(1))
  const schema = z.strictObject({ entries: z.record(identifier, z.string()), ordinary: identifier })
  const result = exported({ RecordSchema: schema }, undefined, { ruleForCheck: goContractRuleForCheck })
  assert.equal(result.schemas.length, 0)
  assert.ok(result.unsupported[0].issues.some(problem => problem.code === 'record-key-normalization'))
})

test('schema-export.shared-principal', () => {
  const names = ['ManagementActionSchema', 'ManagementGrantSchema', 'ManagementPrincipalSchema']
  const result = exportContractSchemas({ modules: new Map([['./management', principals]]),
    selected: names.map(name => `./management#${name}`), source, ruleForCheck: goContractRuleForCheck,
    moduleRoots: [{ module: './management', file: 'dist/management/principals.js', sourceFile: 'src/management/principals.ts' }] })
  assert.deepEqual(result.unsupported, [])
  assert.deepEqual(new Set(result.coverage.exported), new Set(names.map(name => `./management#${name}`)))
  const principal = result.schemas.find(entry => entry.export === 'ManagementPrincipalSchema')
  for (const direction of ['input', 'output']) {
    const refined = schemaNodes(principal[direction]).find(node => node['x-foreman-refinements'])
    const [rule] = refined['x-foreman-refinements']
    assert.equal(rule.kind, 'conditionalPresence')
    assert.equal(rule.discriminator, 'audience')
    assert.equal(rule.field, 'agentId')
    const condition = refined.allOf.find(node => node.if?.properties?.audience)
    assert.equal(condition.if.properties.audience.const, rule.equals)
    assert.deepEqual(condition.then.required, ['agentId'])
    assert.ok(schemaNodes(principal[direction]).some(node => node['x-foreman-normalization']))
  }
})

test('schema-export.source-patterns', () => {
  const result = exported({ TimestampSchema: primitives.TimestampSchema, UUIDSchema: z.uuid() })
  assert.deepEqual(result.unsupported, [])
  for (const entry of result.schemas) {
    for (const direction of ['input', 'output']) {
      const patterns = schemaNodes(entry[direction]).filter(node => typeof node.pattern === 'string')
      assert.ok(patterns.length > 0)
      assert.ok(patterns.every(node => node['x-foreman-regexp'] === 'ecmascript-no-flags'))
    }
  }
  assert.equal(result.validation.format, 'annotation-with-source-pattern')
  assert.equal(result.validation.runtimeQualification, 'requires-separate-terminal-parity-evidence')
})

test('schema-export.local-recursion', () => {
  const recursive = z.lazy(() => z.strictObject({ value: z.string(), next: recursive.optional() }))
  const result = exported({ RecursiveSchema: recursive })
  assert.deepEqual(result.unsupported, [])
  for (const direction of ['input', 'output']) {
    const references = schemaNodes(result.schemas[0][direction]).filter(node => node.$ref)
    assert.ok(references.length > 0)
    assert.ok(references.every(node => node.$ref.startsWith('#')))
  }
})

test('schema-export.conditional-source-check', () => {
  const rule = { kind: 'conditionalPresence', discriminator: 'kind', equals: 'worker', field: 'subject',
    presence: 'truthy', requiredMessage: 'subject required', forbiddenMessage: 'subject forbidden' }
  const schema = withConditionalPresence(z.strictObject({ kind: z.enum(['worker', 'human']),
    subject: z.string().optional() }), [rule])
  const result = exported({ ConditionalSchema: schema }, undefined, { ruleForCheck: goContractRuleForCheck })
  assert.deepEqual(result.unsupported, [])
  assert.equal(schema.safeParse({ kind: 'worker', subject: '' }).success, false)
  assert.equal(schema.safeParse({ kind: 'human', subject: '' }).success, true)
  assert.equal(schema.safeParse({ kind: 'human', subject: 'agent' }).success, false)
  const emitted = schemaNodes(result.schemas[0].input).find(node => node['x-foreman-refinements'])
  assert.deepEqual(emitted['x-foreman-refinements'], [rule])
  const condition = emitted.allOf.find(node => node.if?.properties?.kind)
  assert.deepEqual(condition.else.properties.subject.enum, [false, null, 0, ''])
})
