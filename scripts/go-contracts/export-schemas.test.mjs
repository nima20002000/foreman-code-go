import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportContractSchemas, FROZEN_REFERENCE } from './export-schemas.mjs'
import { normalizedString, withConditionalPresence, goContractRuleForCheck } from '../../packages/contracts/dist/goContractRules.js'
import * as primitives from '../../packages/contracts/dist/schemaPrimitives.js'
import * as principals from '../../packages/contracts/dist/management/principals.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const contractsRequire = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))
const zodRoot = dirname(contractsRequire.resolve('zod/package.json'))
const { z } = await import(pathToFileURL(resolve(zodRoot, 'index.js')).href)
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

test('schema-export.conditional-checks', () => {
  const NumberSchema = z.number().check(z.gte(5, { when: () => false }))
  const StringSchema = z.string().check(z.minLength(5, { when: () => false }))
  assert.equal(NumberSchema.safeParse(1).success, true)
  assert.equal(StringSchema.safeParse('a').success, true)
  const result = exported({ NumberSchema, StringSchema })
  assert.deepEqual(result.coverage.exported, [])
  assert.deepEqual(result.coverage.unsupported, ['fixture#NumberSchema', 'fixture#StringSchema'])
  assert.ok(result.unsupported.every(entry => entry.issues.some(problem => problem.code === 'conditional-check')))
})

function gitRevision(expression) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', expression], { encoding: 'utf8' })
  assert.equal(result.status, 0, `Actual terminal candidate provenance is required: ${result.stderr}`)
  assert.match(result.stdout.trim(), /^[0-9a-f]{40}$/)
  return result.stdout.trim()
}

async function cliFixture(label) {
  const directory = await mkdtemp(join(tmpdir(), `foreman-schema-export-${label}-`))
  const home = join(directory, 'home')
  await mkdir(home)
  return { directory, home, output: join(directory, 'manifest.json') }
}

function invokeCLI(fixture, args, options = {}) {
  const environment = { ...process.env, HOME: fixture.home,
    XDG_CONFIG_HOME: join(fixture.directory, 'config'), XDG_STATE_HOME: join(fixture.directory, 'state'),
    XDG_CACHE_HOME: join(fixture.directory, 'cache'), ...options.environment }
  delete environment.GIT_DIR
  delete environment.GIT_WORK_TREE
  const result = spawnSync(process.env.SCHEMA_EXPORT_RUNTIME ?? process.execPath,
    [options.script ?? resolve(root, 'scripts/go-contracts/export-schemas.mjs'), ...args],
    { cwd: options.cwd ?? root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: environment })
  assert.ifError(result.error)
  assert.equal(result.signal, null, 'The CLI must finish naturally')
  return result
}

test('schema-export.cli-arguments', async () => {
  const fixture = await cliFixture('arguments')
  for (const args of [[], ['--output'],
    ['--module', '.=../outside.js', '--select', '.#IdSchema', '--output', fixture.output],
    ['--module', '.=dist/schemaPrimitives.js', '--select', './management#ManagementActionSchema', '--output', fixture.output],
  ]) {
    const result = invokeCLI(fixture, args)
    assert.equal(result.status, 2, `Invalid arguments must fail configuration: ${result.stderr}`)
    assert.match(result.stderr, /Usage|Missing|inside packages\/contracts\/dist/)
  }
})

test('schema-export.cli-coverage', async () => {
  const fixture = await cliFixture('coverage')
  const selected = ['.#IdSchema', './management#ManagementActionSchema',
    './management#ManagementGrantSchema', './management#ManagementPrincipalSchema']
  const result = invokeCLI(fixture, ['--module', '.=dist/schemaPrimitives.js',
    '--module', './management=dist/management/principals.js',
    ...selected.flatMap(id => ['--select', id]), '--output', fixture.output])
  assert.equal(result.status, 0, `Affected auth export must be complete: ${result.stderr} ${result.stdout}`)
  const manifest = JSON.parse(await readFile(fixture.output, 'utf8'))
  assert.equal(manifest.source.reference, FROZEN_REFERENCE)
  assert.equal(manifest.source.candidate, gitRevision('HEAD^{commit}'))
  assert.equal(manifest.source.tree, gitRevision('HEAD^{tree}'))
  assert.deepEqual(manifest.coverage.selected, selected)
  assert.deepEqual(manifest.coverage.exported, selected)
  assert.deepEqual(manifest.coverage.unsupported, [])
  assert.equal(manifest.coverage.scope, 'explicit-module-roots')
  assert.equal(manifest.coverage.counts.selected, 4)
  assert.equal(manifest.source.compiledRoots.length, 2)
  for (const compiled of [...manifest.source.compiledRoots, manifest.source.compiledHelper]) {
    assert.ok(compiled, 'The actual compiled source helper must be recorded')
    const bytes = await readFile(resolve(root, 'packages/contracts', compiled.file))
    assert.equal(compiled.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(compiled.sourceBlob, gitRevision('HEAD:packages/contracts/' + compiled.sourceFile))
  }
  assert.equal(manifest.source.compiledHelper.file, 'dist/goContractRules.js')
  assert.equal(manifest.validation.runtimeQualification, 'requires-separate-terminal-parity-evidence')
})

test('schema-export.cli-incomplete-selection', async () => {
  const fixture = await cliFixture('incomplete')
  const result = invokeCLI(fixture, ['--module', './management=dist/management/principals.js',
    '--select', './management#ManagementActionSchema', '--select', './management#MissingSchema', '--output', fixture.output])
  assert.equal(result.status, 1, `Incomplete selection must retain a failing coverage report: ${result.stderr}`)
  const manifest = JSON.parse(await readFile(fixture.output, 'utf8'))
  assert.deepEqual(manifest.coverage.exported, ['./management#ManagementActionSchema'])
  assert.deepEqual(manifest.coverage.unsupported, ['./management#MissingSchema'])
  assert.equal(manifest.unsupported[0].issues[0].code, 'missing-schema-export')
  assert.equal(manifest.coverage.counts.selected, 2)
  assert.equal(manifest.coverage.counts.exported + manifest.coverage.counts.unsupported, 2)
  assert.match(result.stdout, /MissingSchema/)
})

test('schema-export.cli-missing-provenance', async () => {
  const fixture = await cliFixture('provenance')
  const isolatedRoot = join(fixture.directory, 'untracked-source')
  const script = join(isolatedRoot, 'scripts/go-contracts/export-schemas.mjs')
  const contracts = join(isolatedRoot, 'packages/contracts')
  await mkdir(dirname(script), { recursive: true })
  await mkdir(join(contracts, 'node_modules'), { recursive: true })
  await copyFile(resolve(root, 'scripts/go-contracts/export-schemas.mjs'), script)
  await copyFile(resolve(root, 'packages/contracts/package.json'), join(contracts, 'package.json'))
  await symlink(zodRoot, join(contracts, 'node_modules/zod'), 'dir')
  const result = invokeCLI(fixture, ['--module', '.=dist/schemaPrimitives.js',
    '--select', '.#IdSchema', '--output', fixture.output], {
    script, cwd: isolatedRoot, environment: { GIT_CEILING_DIRECTORIES: fixture.directory },
  })
  assert.equal(result.status, 2, 'An untracked copy cannot create a source-attributed manifest')
  assert.match(result.stderr, /not a git repository|git.*rev-parse/i)
  await assert.rejects(readFile(fixture.output), { code: 'ENOENT' })
})
