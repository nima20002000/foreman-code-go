// Run generation only in terminal-owned Foreman CI. Importing this module does
// not run the CLI, compile contracts, or create a manifest.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

export const FROZEN_REFERENCE = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
export const MERGED_BASE = '7fa547058109519a99c904493c916662fde6a474'
const runFile = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const contractsRoot = resolve(repositoryRoot, 'packages/contracts')
const requireContracts = createRequire(resolve(contractsRoot, 'package.json'))
const { z } = requireContracts('zod')

const simpleTypes = new Set([
  'string', 'number', 'boolean', 'null', 'never', 'any', 'unknown',
  'enum', 'literal', 'array', 'object', 'union', 'intersection', 'tuple',
  'record', 'nullable', 'optional', 'nonoptional', 'readonly', 'lazy',
])
const ordinaryChecks = new Set([
  'less_than', 'greater_than', 'multiple_of', 'number_format',
  'min_length', 'max_length', 'length_equals', 'describe', 'meta',
])
// These formats have complete, flag-free patterns in the pinned Zod 4.6.3
// implementation. Other format families need explicit parity qualification.
const patternFormats = new Set(['regex', 'uuid', 'guid', 'datetime', 'date', 'time'])
const compatibilityEdits = new Set([
  'packages/contracts/src/goContractRules.ts',
  'packages/contracts/src/schemaPrimitives.ts',
  'packages/contracts/src/management/principals.ts',
])

function isSchema(value) {
  return value !== null && typeof value === 'object' &&
    typeof value._zod?.def?.type === 'string'
}

function identity(module, name) {
  if (typeof module !== 'string' || !module || module.includes('#') ||
      typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new Error('A schema identity requires a module and an exported JavaScript name')
  }
  return `${module}#${name}`
}

function selection(value) {
  if (typeof value === 'object' && value !== null) {
    return { module: value.module, export: value.export, id: identity(value.module, value.export) }
  }
  if (typeof value !== 'string' || value.indexOf('#') !== value.lastIndexOf('#')) {
    throw new Error('Select an exact module#ExportSchema identity')
  }
  const marker = value.indexOf('#')
  if (marker < 1 || marker === value.length - 1) throw new Error('Select an exact module#ExportSchema identity')
  const module = value.slice(0, marker)
  const name = value.slice(marker + 1)
  return { module, export: name, id: identity(module, name) }
}

function issue(path, code, detail) {
  return { path: [...path], code, detail }
}

function metadata(schema) {
  return typeof schema.meta === 'function' ? schema.meta() : undefined
}

function ruleMetadata(schema, path, issues) {
  const declaration = metadata(schema)?.foremanGo
  if (declaration === undefined) return { normalization: [], refinements: [] }
  if (declaration === null || declaration.version !== 1 ||
      Object.keys(declaration).some(key => !['version', 'normalization', 'refinements'].includes(key)) ||
      (declaration.normalization !== undefined && !Array.isArray(declaration.normalization)) ||
      (declaration.refinements !== undefined && !Array.isArray(declaration.refinements))) {
    issues.push(issue(path, 'unsupported-rule-metadata', 'Expected the source-owned foremanGo version-1 rule declaration'))
    return { normalization: [], refinements: [] }
  }
  return {
    normalization: declaration.normalization ?? [],
    refinements: declaration.refinements ?? [],
  }
}

function validateRule(rule, check, schema, path, issues) {
  if (rule?.kind === 'trim' && check._zod.def.check === 'overwrite' && schema._zod.def.type === 'string') {
    if (Object.keys(rule).length === 1) return true
  }
  if (rule?.kind === 'conditionalPresence' && check._zod.def.check === 'custom' &&
      schema._zod.def.type === 'object' && rule.presence === 'truthy' &&
      ['discriminator', 'equals', 'field', 'requiredMessage', 'forbiddenMessage']
        .every(key => typeof rule[key] === 'string') &&
      Object.hasOwn(schema._zod.def.shape, rule.discriminator) &&
      Object.hasOwn(schema._zod.def.shape, rule.field) &&
      Object.keys(rule).every(key => ['kind', 'discriminator', 'equals', 'field', 'presence',
        'requiredMessage', 'forbiddenMessage'].includes(key))) return true
  issues.push(issue(path, 'unsupported-source-rule', 'The registered source rule is not supported at this schema node'))
  return false
}

function inspectChecks(schema, path, ruleForCheck, issues) {
  const rules = ruleMetadata(schema, path, issues)
  const declared = [...rules.normalization, ...rules.refinements]
  const registered = []
  const definition = schema._zod.def
  const checks = schema._zod.traits?.has('$ZodCheck')
    ? [schema, ...(definition.checks ?? [])] : (definition.checks ?? [])
  let ordinarySeen = false
  for (const check of checks) {
    const detail = check?._zod?.def
    const kind = detail?.check
    if (kind === 'overwrite' || kind === 'custom') {
      const rule = ruleForCheck?.(check)
      if (!rule || !declared.includes(rule)) {
        issues.push(issue(path, 'unbound-runtime-check', `${kind} requires the exact shared helper check and rule identity`))
        continue
      }
      registered.push(rule)
      if (!validateRule(rule, check, schema, path, issues)) continue
      if (rule.kind === 'trim' && ordinarySeen) {
        issues.push(issue(path, 'normalization-order', 'A trim after an ordinary constraint cannot be normalized before validation'))
      }
      if (rule.kind !== 'trim') ordinarySeen = true
      continue
    }
    if (kind === 'string_format') {
      if (!patternFormats.has(detail.format) || !(detail.pattern instanceof RegExp)) {
        issues.push(issue(path, 'unqualified-string-format', `Format ${String(detail.format)} needs a complete source pattern and parity evidence`))
      } else if (detail.pattern.flags !== '') {
        issues.push(issue(path, 'regexp-flags', 'JSON Schema conversion cannot discard JavaScript regular-expression flags'))
      }
    } else if (!ordinaryChecks.has(kind)) {
      issues.push(issue(path, 'unsupported-check', `Unsupported Zod runtime check ${String(kind)}`))
    }
    if (!['describe', 'meta'].includes(kind)) ordinarySeen = true
  }
  for (const rule of declared) {
    if (!registered.includes(rule) || registered.filter(found => found === rule).length !== 1) {
      issues.push(issue(path, 'unbound-rule-metadata', 'Every declared rule must identify exactly one actual source helper check'))
    }
    if (rules.normalization.includes(rule) !== (rule?.kind === 'trim')) {
      issues.push(issue(path, 'rule-category', 'Normalization and refinement declarations must retain their source category'))
    }
  }
  return rules
}

function childSchemas(schema, path) {
  const definition = schema._zod.def
  switch (definition.type) {
    case 'object': return [
      ...Object.entries(definition.shape).map(([key, value]) => [value, [...path, 'properties', key]]),
      ...(definition.catchall ? [[definition.catchall, [...path, 'additionalProperties']]] : []),
    ]
    case 'array': return [[definition.element, [...path, 'items']]]
    case 'record': return [
      [definition.keyType, [...path, 'propertyNames'], true], [definition.valueType, [...path, 'additionalProperties']],
    ]
    case 'tuple': return [
      ...definition.items.map((item, index) => [item, [...path, 'prefixItems', index]]),
      ...(definition.rest ? [[definition.rest, [...path, 'items']]] : []),
    ]
    case 'union': return definition.options.map((item, index) => [item, [...path, 'anyOf', index]])
    case 'intersection': return [[definition.left, [...path, 'allOf', 0]], [definition.right, [...path, 'allOf', 1]]]
    case 'nullable': return [[definition.innerType, [...path, 'anyOf', 0]]]
    case 'optional': case 'nonoptional': case 'readonly': return [[definition.innerType, path]]
    // Use the same memoized inner schema as Zod's pinned JSON Schema processor.
    case 'lazy': return [[schema._zod.innerType, path]]
    default: return []
  }
}

function inspectSchema(root, ruleForCheck) {
  const issues = []
  const rulesBySchema = new Map()
  const visited = new Map()
  const pending = [[root, []]]
  while (pending.length) {
    const [schema, path, recordKey = false] = pending.pop()
    if (!isSchema(schema)) {
      issues.push(issue(path, 'invalid-schema-child', 'Expected a Zod schema in the source graph'))
      continue
    }
    const contextBit = recordKey ? 2 : 1
    if ((visited.get(schema) ?? 0) & contextBit) continue
    visited.set(schema, (visited.get(schema) ?? 0) | contextBit)
    const definition = schema._zod.def
    if (!simpleTypes.has(definition.type)) {
      issues.push(issue(path, 'unsupported-type', `Zod ${definition.type} changes or accepts values outside the supported JSON contract`))
      continue
    }
    if (definition.coerce) issues.push(issue(path, 'coercion', 'Implicit JavaScript coercion requires an explicit source-owned adapter'))
    if (typeof schema._zod.toJSONSchema === 'function') {
      issues.push(issue(path, 'custom-json-schema', 'A custom schema override needs a source-owned validation adapter'))
    }
    if (definition.type === 'object' && !definition.catchall) {
      issues.push(issue(path, 'strip-unknown-keys', 'Stripping unknown object keys requires a source-owned normalization adapter'))
    }
    const rules = inspectChecks(schema, path, ruleForCheck, issues)
    if (recordKey && rules.normalization.length) {
      issues.push(issue(path, 'record-key-normalization', 'Renaming record keys requires a dedicated source-owned adapter'))
    }
    rulesBySchema.set(schema, rules)
    pending.push(...childSchemas(schema, path).map(([child, childPath, childRecordKey]) =>
      [child, childPath, recordKey || childRecordKey]))
  }
  return { issues, rulesBySchema }
}

function conditionalSchema(rule) {
  const falsyJSON = [false, null, 0, '']
  return {
    if: { properties: { [rule.discriminator]: { const: rule.equals } }, required: [rule.discriminator] },
    then: { required: [rule.field], properties: { [rule.field]: { not: { enum: falsyJSON } } } },
    else: { properties: { [rule.field]: { enum: falsyJSON } } },
  }
}

function annotatePatterns(schema) {
  if (schema === null || typeof schema !== 'object') return
  if (typeof schema.pattern === 'string') schema['x-foreman-regexp'] = 'ecmascript-no-flags'
  for (const key of ['properties', 'patternProperties', '$defs', 'dependentSchemas']) {
    for (const child of Object.values(schema[key] ?? {})) annotatePatterns(child)
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    for (const child of schema[key] ?? []) annotatePatterns(child)
  }
  for (const key of ['items', 'additionalProperties', 'contains', 'propertyNames',
    'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems']) {
    annotatePatterns(schema[key])
  }
}

function convertSchema(schema, direction, rulesBySchema) {
  const converted = z.toJSONSchema(schema, {
    target: 'draft-2020-12', io: direction, unrepresentable: 'throw',
    cycles: 'ref', reused: 'inline', metadata: z.registry(),
    override({ zodSchema, jsonSchema }) {
      const rules = rulesBySchema.get(zodSchema)
      if (!rules) return
      const description = metadata(zodSchema)?.description
      if (typeof description === 'string') jsonSchema.description = description
      if (rules.normalization.length) jsonSchema['x-foreman-normalization'] = rules.normalization
      if (rules.refinements.length) {
        jsonSchema['x-foreman-refinements'] = rules.refinements
        jsonSchema.allOf = [...(jsonSchema.allOf ?? []), ...rules.refinements.map(conditionalSchema)]
      }
      if (jsonSchema.format && zodSchema._zod.def.type === 'string') {
        jsonSchema['x-foreman-format-assertion'] = 'source-pattern'
      }
    },
  })
  annotatePatterns(converted)
  return converted
}

/** Export exact selected runtime Zod objects, with exhaustive scoped coverage. */
export function exportContractSchemas({ modules, selected, source, ruleForCheck, moduleRoots = [] }) {
  if (!(modules instanceof Map) || !Array.isArray(selected) || selected.length === 0) {
    throw new Error('Supply a Map of explicit module roots and at least one selected schema')
  }
  if (source?.reference !== FROZEN_REFERENCE) throw new Error('The frozen TypeScript reference cannot be refreshed')
  if (ruleForCheck !== undefined && typeof ruleForCheck !== 'function') throw new Error('ruleForCheck must be the shared helper accessor')
  const wanted = selected.map(selection)
  if (new Set(wanted.map(item => item.id)).size !== wanted.length) throw new Error('Duplicate selected schema identity')
  const discovered = []
  const nonSchemaExports = []
  for (const [module, exports] of modules) {
    for (const [name, value] of Object.entries(exports)) {
      const id = identity(module, name)
      ;(isSchema(value) ? discovered : nonSchemaExports).push(id)
    }
  }
  discovered.sort()
  nonSchemaExports.sort()
  const schemas = []
  const unsupported = []
  for (const item of wanted.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
    const value = modules.get(item.module)?.[item.export]
    if (!isSchema(value)) {
      unsupported.push({ ...item, issues: [issue([], 'missing-schema-export', 'The selected module root does not export this Zod schema')] })
      continue
    }
    let inspected
    try { inspected = inspectSchema(value, ruleForCheck) }
    catch (error) {
      if (!(error instanceof Error)) throw error
      unsupported.push({ ...item, issues: [issue([], 'schema-inspection', error.message)] })
      continue
    }
    if (inspected.issues.length) {
      unsupported.push({ ...item, issues: inspected.issues })
      continue
    }
    try {
      schemas.push({ ...item, input: convertSchema(value, 'input', inspected.rulesBySchema),
        output: convertSchema(value, 'output', inspected.rulesBySchema) })
    } catch (error) {
      if (!(error instanceof Error)) throw error
      unsupported.push({ ...item, issues: [issue([], 'json-schema-conversion', error.message)] })
    }
  }
  const selectedIDs = wanted.map(item => item.id)
  const coverage = {
    scope: 'explicit-module-roots', moduleRoots,
    discovered, selected: selectedIDs, exported: schemas.map(item => item.id),
    unsupported: unsupported.map(item => item.id),
    unselected: discovered.filter(id => !selectedIDs.includes(id)), nonSchemaExports,
  }
  coverage.counts = Object.fromEntries(['discovered', 'selected', 'exported', 'unsupported', 'unselected']
    .map(key => [key, coverage[key].length]))
  return {
    schemaVersion: 1, draft: '2020-12', source: { package: '@foreman-code/contracts', ...source },
    validation: {
      valueDomain: 'JSON', normalization: 'before-json-schema', format: 'annotation-with-source-pattern',
      stringLength: 'unicode-code-points', stringRepresentation: 'lossless-utf16', patternDialect: 'ecmascript-no-flags',
      runtimeQualification: 'requires-separate-terminal-parity-evidence',
    },
    schemas, coverage, unsupported,
  }
}

async function git(...args) {
  const result = await runFile('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trim()
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

async function sourceIdentity(moduleRoots) {
  const candidate = await git('rev-parse', 'HEAD')
  await git('merge-base', '--is-ancestor', MERGED_BASE, candidate)
  const dirty = await git('status', '--porcelain', '--untracked-files=normal', '--',
    'packages/contracts/src', 'packages/contracts/package.json', 'scripts/go-contracts/export-schemas.mjs')
  if (dirty) throw new Error('Commit the exact shared contract source before terminal capture; dirty source is not reproducible')
  const changed = await git('diff', '--name-only', FROZEN_REFERENCE, candidate, '--',
    'packages/contracts/src', 'packages/contracts/package.json')
  const edited = changed ? changed.split('\n') : []
  const unapproved = edited.filter(path => !compatibilityEdits.has(path))
  if (unapproved.length) throw new Error(`Frozen contract source changed outside approved rule metadata: ${unapproved.join(', ')}`)
  const packageBytes = await readFile(resolve(contractsRoot, 'package.json'))
  const packageJSON = JSON.parse(packageBytes)
  if (packageJSON.name !== '@foreman-code/contracts' || packageJSON.dependencies?.zod !== '4.6.3') {
    throw new Error('The exporter requires the pinned shared contracts package and Zod 4.6.3')
  }
  const zodPackage = JSON.parse(await readFile(requireContracts.resolve('zod/package.json')))
  if (zodPackage.version !== '4.6.3') throw new Error('Installed Zod does not match the frozen shared package dependency')
  await git('cat-file', '-e', `${candidate}:scripts/go-contracts/export-schemas.mjs`)
  return {
    package: packageJSON.name, reference: FROZEN_REFERENCE, mergedBase: MERGED_BASE,
    candidate, tree: await git('rev-parse', `${candidate}^{tree}`),
    contractsTree: await git('rev-parse', `${candidate}:packages/contracts/src`),
    frozenContractsTree: await git('rev-parse', `${FROZEN_REFERENCE}:packages/contracts/src`),
    compatibilityEdits: edited, zodVersion: zodPackage.version,
    packageSHA256: sha256(packageBytes), exporterSHA256: sha256(await readFile(fileURLToPath(import.meta.url))),
    compiledRoots: await Promise.all(moduleRoots.map(async root => ({ ...root,
      sha256: sha256(await readFile(resolve(contractsRoot, root.file))),
    }))),
    buildEvidence: 'A separate terminal CI ticket must establish the affected source compilation; file hashes are not execution evidence',
  }
}

function parseArguments(args) {
  const selected = []
  const mappings = new Map()
  let output
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
    if (option === '--select') selected.push(selection(value))
    else if (option === '--output' && output === undefined) output = resolve(value)
    else if (option === '--module') {
      const marker = value.indexOf('=')
      const module = value.slice(0, marker)
      const file = value.slice(marker + 1)
      identity(module, 'Schema')
      const absolute = resolve(contractsRoot, file)
      const withinDist = relative(resolve(contractsRoot, 'dist'), absolute)
      if (marker < 1 || !withinDist || withinDist === '..' || withinDist.startsWith(`..${sep}`) ||
          !/\.(?:mjs|js)$/.test(withinDist) || mappings.has(module)) {
        throw new Error('Each logical module must map once to a compiled file inside packages/contracts/dist')
      }
      mappings.set(module, { module, file: relative(contractsRoot, absolute).split(sep).join('/'),
        sourceFile: 'src/' + withinDist.split(sep).join('/').replace(/\.mjs$/, '.mts').replace(/\.js$/, '.ts') })
    } else throw new Error(`Unknown or repeated option ${option}`)
  }
  if (!output || !selected.length || !mappings.size) {
    throw new Error('Usage: node scripts/go-contracts/export-schemas.mjs --module <logical>=dist/<entry.js> --select <logical>#<ExportSchema> --output <manifest.json>')
  }
  for (const item of selected) if (!mappings.has(item.module)) throw new Error(`Missing explicit module root for ${item.module}`)
  for (const module of mappings.keys()) if (!selected.some(item => item.module === module)) throw new Error(`Module ${module} has no selected schema`)
  return { selected, moduleRoots: [...mappings.values()], output }
}

/** Produce the requested manifest and return a nonzero status for incomplete selection. */
export async function runExportCLI(args) {
  const { selected, moduleRoots, output } = parseArguments(args)
  const source = await sourceIdentity(moduleRoots)
  for (const root of moduleRoots) {
    await git('cat-file', '-e', `${source.candidate}:packages/contracts/${root.sourceFile}`)
  }
  const modules = new Map(await Promise.all(moduleRoots.map(async root => [root.module,
    await import(pathToFileURL(resolve(contractsRoot, root.file)).href),
  ])))
  const helper = await import(pathToFileURL(resolve(contractsRoot, 'dist/goContractRules.js')).href)
  const manifest = exportContractSchemas({ modules, selected, source, moduleRoots,
    ruleForCheck: helper.goContractRuleForCheck })
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ output, coverage: manifest.coverage,
    unsupported: manifest.unsupported, source: { reference: source.reference, candidate: source.candidate } }) + '\n')
  return manifest.unsupported.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runExportCLI(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 2
  }
}
