// Terminal Foreman CI only. This module does not invoke compilers, formatters,
// tests or dependency installation. DTO declarations come only from the
// selected shared-contract exporter descriptors, never a second field catalog.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frozen = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const base = '7fa547058109519a99c904493c916662fde6a474'
const policies = {
  valueDomain: 'JSON', normalization: 'before-json-schema', format: 'annotation-with-source-pattern',
  stringLength: 'unicode-code-points', stringRepresentation: 'lossless-utf16', patternDialect: 'ecmascript-no-flags',
  runtimeQualification: 'requires-separate-terminal-parity-evidence', execution: 'zod-default-en',
}
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const ascii = value => typeof value === 'string' && /^[\x00-\x7f]*$/.test(value)
const own = (value, key) => Object.hasOwn(value, key)
const fingerprint = value => JSON.stringify(value)

export class GenerationError extends Error {
  constructor(code, detail, schema, path = []) {
    super(detail)
    this.name = 'GenerationError'
    this.diagnostic = { code, detail, ...(schema ? { schema } : {}), path }
  }
}

function fail(code, detail, schema, path) { throw new GenerationError(code, detail, schema, path) }
function keys(value, allowed, schema, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('descriptor-object', 'Expected an execution descriptor object', schema, path)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('unsupported-descriptor-field', `Unsupported execution field ${key}`, schema, [...path, key])
}

function admittedLocale(locale) {
  return locale?.repository === 'colinhacks/zod' && locale.reference === 'v4.6.3' &&
    locale.sourceFile === 'packages/zod/src/v4/locales/en.ts' && locale.sourceBlob === '3836bd1651071082fb24488d4e3b3d29db851134' &&
    locale.installedFile === 'v4/locales/en.js' && /^[0-9a-f]{64}$/.test(locale.installedSHA256) && locale.moduleFormat === 'esm' &&
    locale.binding === 'exporter-created-factory-policy' && ['explicit-public-binding', 'before-selected-module-imports'].includes(locale.phase)
}

function checkPattern(pattern, schema, path) {
  if (!ascii(pattern)) fail('unsupported-pattern', 'Patterns require the bounded flag-free positive ASCII subset', schema, path)
  let inClass = false
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') {
      const escaped = pattern[++index]
      if (!escaped || !'d.+*?()[]{}|^$\\/-'.includes(escaped)) fail('unsupported-pattern', 'An ECMAScript escape needs an explicit runtime adapter', schema, path)
    } else if (char === '[') {
      if (inClass || pattern[index + 1] === '^') fail('unsupported-pattern', 'Negated/nested character classes are not supported', schema, path)
      inClass = true
    } else if (char === ']') inClass = false
    else if (!inClass && char === '.') fail('unsupported-pattern', 'Wildcard matching needs a separate UTF-16 adapter', schema, path)
    else if (!inClass && char === '(' && pattern[index + 1] === '?' && pattern[index + 2] !== ':') fail('unsupported-pattern', 'Lookaround and mode changes are not supported', schema, path)
  }
  try { new RegExp(pattern) } catch { fail('unsupported-pattern', 'Invalid source ECMAScript pattern', schema, path) }
}

function admitCheck(check, node, schema, path) {
  keys(check, ['kind', 'abort', 'when', 'minimum', 'maximum', 'length', 'value', 'inclusive', 'format', 'pattern', 'patternDisplay', 'rule'], schema, path)
  if (typeof check.abort !== 'boolean' || !['length', 'unaborted'].includes(check.when)) fail('unsupported-check-policy', 'Explicit source abort/when policy is required', schema, path)
  const length = ['min_length', 'max_length', 'length_equals'].includes(check.kind)
  if ((check.when === 'length') !== length) fail('unsupported-check-policy', 'Only the pinned default length predicate is supported', schema, path)
  const required = {
    min_length: ['minimum'], max_length: ['maximum'], length_equals: ['length'],
    greater_than: ['value', 'inclusive'], less_than: ['value', 'inclusive'],
    overwrite: ['rule'], custom: ['rule'], number_format: ['format'], string_format: ['format', 'pattern', 'patternDisplay'],
  }[check.kind]
  if (!required) fail('unsupported-check', `Unsupported source check ${check.kind}`, schema, path)
  for (const key of required) if (!own(check, key)) fail('incomplete-check', `Missing source check ${key}`, schema, path)
  for (const key of Object.keys(check)) if (!['kind', 'abort', 'when', ...required].includes(key)) fail('unrelated-check-field', `Unrelated source check ${key}`, schema, path)
  if (length) {
    if (!['string', 'array'].includes(node.kind) || !Number.isSafeInteger(check[required[0]]) || check[required[0]] < 0) fail('unsupported-length', 'Length constraints require nonnegative safe integers on strings or arrays', schema, path)
  } else if (check.kind === 'string_format') {
    if (node.kind !== 'string' || !['regex', 'uuid', 'guid', 'datetime', 'date', 'time'].includes(check.format) || typeof check.patternDisplay !== 'string') fail('unsupported-format', 'Unsupported source string format', schema, path)
    checkPattern(check.pattern, schema, [...path, 'pattern'])
  } else if (check.kind === 'number_format') {
    if (node.kind !== 'number' || check.format !== 'safeint') fail('unsupported-number-format', 'Only source safeint is supported', schema, path)
  } else if (['greater_than', 'less_than'].includes(check.kind)) {
    if (node.kind !== 'number' || typeof check.value !== 'number' || !Number.isFinite(check.value) || typeof check.inclusive !== 'boolean') fail('unsupported-number-bound', 'Numeric bounds require finite source numbers and explicit inclusivity', schema, path)
  } else if (check.kind === 'overwrite') {
    keys(check.rule, ['kind'], schema, [...path, 'rule'])
    if (node.kind !== 'string' || check.rule.kind !== 'trim') fail('unsupported-rule', 'Only source-bound string trim is supported', schema, path)
  } else {
    keys(check.rule, ['kind', 'discriminator', 'equals', 'field', 'presence', 'requiredMessage', 'forbiddenMessage'], schema, [...path, 'rule'])
    const rule = check.rule
    if (node.kind !== 'object' || rule.kind !== 'conditionalPresence' || rule.presence !== 'truthy' ||
        !node.properties?.some(item => item.key === rule.discriminator) || !node.properties?.some(item => item.key === rule.field) ||
        !['equals', 'requiredMessage', 'forbiddenMessage'].every(key => typeof rule[key] === 'string') || !rule.requiredMessage || !rule.forbiddenMessage) {
      fail('unsupported-rule', 'Custom checks require the source-bound conditional presence declaration', schema, path)
    }
  }
}

function admitNode(node, schema, path = []) {
  keys(node, ['kind', 'checks', 'inner', 'element', 'properties', 'unknownKeys', 'values'], schema, path)
  if (!Array.isArray(node.checks)) fail('missing-checks', 'Ordered source checks are required', schema, path)
  if (!['string', 'number', 'enum', 'literal', 'object', 'array', 'optional', 'nullable'].includes(node.kind)) fail('unsupported-node', `Unsupported source node ${node.kind}`, schema, path)
  const extras = { object: ['properties', 'unknownKeys'], array: ['element'], optional: ['inner'], nullable: ['inner'], enum: ['values'], literal: ['values'] }[node.kind] ?? []
  for (const key of Object.keys(node)) if (!['kind', 'checks', ...extras].includes(key)) fail('unrelated-node-field', `Unrelated source node ${key}`, schema, path)
  if (node.kind === 'object') {
    if (node.unknownKeys !== 'strict' || !Array.isArray(node.properties)) fail('unsupported-object', 'Only source strict objects are supported', schema, path)
    const seen = new Set()
    for (const item of node.properties) {
      keys(item, ['key', 'node'], schema, [...path, 'properties'])
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(item.key) || ['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'].includes(item.key) || seen.has(item.key)) fail('unsupported-property', 'Property lookup or Go naming needs an explicit adapter', schema, [...path, 'properties', item.key])
      seen.add(item.key)
      admitNode(item.node, schema, [...path, 'properties', item.key])
    }
  } else if (node.kind === 'array') admitNode(node.element, schema, [...path, 'element'])
  else if (['optional', 'nullable'].includes(node.kind)) admitNode(node.inner, schema, [...path, 'inner'])
  else if (['enum', 'literal'].includes(node.kind)) {
    if (!Array.isArray(node.values) || !node.values.length || node.values.some(value => !ascii(value)) || new Set(node.values).size !== node.values.length) fail('unsupported-values', 'Only distinct ASCII string enum/literal values are supported', schema, path)
  }
  node.checks.forEach((check, index) => admitCheck(check, node, schema, [...path, 'checks', index]))
}

function validateManifest(manifest, selected) {
  const source = manifest?.source
  if (manifest?.schemaVersion !== 1 || manifest.draft !== '2020-12' || source?.package !== '@foreman-code/contracts' ||
      source.reference !== frozen || source.mergedBase !== base || source.zodVersion !== '4.6.3' ||
      ![source.candidate, source.tree, source.contractsTree].every(sha)) fail('source-identity', 'A pinned shared-contract manifest with full source identities is required')
  for (const [key, value] of Object.entries(policies)) if (manifest.validation?.[key] !== value) fail('execution-policy', `Unsupported or missing validation policy ${key}`)
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) fail('selection', 'Provide distinct explicit schema IDs')
  if (!Array.isArray(manifest.schemas) || !Array.isArray(manifest.unsupported) || manifest.unsupported.length || manifest.coverage?.unsupported?.length !== 0) fail('unsupported-selection', 'Every selected root must have exported execution metadata')
  const entries = new Map()
  for (const entry of manifest.schemas) {
    if (entry.id !== entry.module + '#' + entry.export || entries.has(entry.id)) fail('schema-identity', 'Duplicate or inconsistent schema identity')
    entries.set(entry.id, entry)
    if (!entry.input || !entry.output) fail('missing-json-schema', 'Both source schema directions are required', entry.id)
    const runtime = entry.runtime
    keys(runtime, ['version', 'zodVersion', 'selector', 'errorPolicy', 'locale', 'root'], entry.id, ['runtime'])
    if (runtime.version !== 1 || runtime.zodVersion !== '4.6.3' || runtime.selector !== 'zod-default-en' || runtime.errorPolicy !== 'default-en' || !admittedLocale(runtime.locale)) fail('execution-policy', 'Pinned ordered execution and English policy metadata are required', entry.id)
    admitNode(runtime.root, entry.id, ['runtime', 'root'])
  }
  const expected = [...selected].sort()
  for (const actual of [[...entries.keys()], manifest.coverage?.selected, manifest.coverage?.exported]) {
    if (!Array.isArray(actual) || JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) fail('selection', 'Explicit selection must equal the manifest selected/exported roots')
  }
  return expected.map(id => entries.get(id))
}

const initialisms = new Map([['id', 'ID'], ['ids', 'IDs'], ['url', 'URL'], ['urls', 'URLs'], ['http', 'HTTP'], ['json', 'JSON'], ['api', 'API'], ['rpc', 'RPC'], ['uuid', 'UUID']])
function goName(value, schema) {
  const words = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
  let result = words.map(word => initialisms.get(word.toLowerCase()) ?? word[0].toUpperCase() + word.slice(1)).join('')
  if (!/^[A-Z][A-Za-z0-9]*$/.test(result)) fail('go-name', `Source name cannot form an exported Go identifier: ${value}`, schema)
  return result
}

/** Returns authored output bytes; it does not compile or qualify the output. */
export function generateGoContracts({ manifest, selected }) {
  const roots = validateManifest(manifest, selected)
  const names = new Map()
  const types = new Map()
  const definitions = new Map()
  const reserved = new Set(['Text', 'Optional', 'Nullable', 'Registry', 'Issue', 'ValidationError', 'Provenance', 'SchemaDirection', 'SchemaSupportError', 'NewGeneratedRegistry', 'generatedSchemaManifest'])
  function claim(name, identity, schema) {
    if (reserved.has(name) || names.has(name) && names.get(name) !== identity) fail('go-name-collision', `Generated identifier collision: ${name}`, schema)
    names.set(name, identity)
    return name
  }
  const rootNames = new Map(roots.map(entry => [entry.id, goName(entry.export.replace(/Schema$/, ''), entry.id)]))
  for (const entry of roots) {
    const name = rootNames.get(entry.id)
    claim(name, entry.id, entry.id)
    claim(name + 'SchemaID', entry.id + ':id', entry.id)
    claim('Parse' + name, entry.id + ':parse', entry.id)
    claim('Validate' + name, entry.id + ':validate', entry.id)
    if (!types.has(fingerprint(entry.runtime.root))) types.set(fingerprint(entry.runtime.root), name)
  }
  function typeOf(node, hint, schema, defining) {
    const key = fingerprint(node)
    const existing = types.get(key)
    if (existing && existing !== defining) return existing
    if (node.kind === 'string') return 'Text'
    if (node.kind === 'number') return 'float64'
    if (node.kind === 'optional') return `Optional[${typeOf(node.inner, hint, schema)}]`
    if (node.kind === 'nullable') return `Nullable[${typeOf(node.inner, hint, schema)}]`
    if (node.kind === 'array') return `[]${typeOf(node.element, hint + 'Item', schema)}`
    const name = defining ?? claim(hint, schema + ':' + key, schema)
    types.set(key, name)
    if (definitions.has(name)) return name
    definitions.set(name, '')
    if (node.kind === 'object') {
      const fieldNames = new Set()
      const fields = node.properties.map(property => {
        const fieldName = goName(property.key, schema)
        if (fieldNames.has(fieldName)) fail('go-name-collision', `Generated field collision: ${fieldName}`, schema)
        fieldNames.add(fieldName)
        const fieldType = typeOf(property.node, name + fieldName, schema)
        let wrapper = property.node
        while (wrapper.kind === 'nullable') wrapper = wrapper.inner
        const tag = JSON.stringify(property.key + (wrapper.kind === 'optional' ? ',omitzero' : ''))
        return `\t${fieldName} ${fieldType} \x60json:${tag}\x60`
      })
      definitions.set(name, `type ${name} struct {\n${fields.join('\n')}\n}\n`)
    } else {
      const constants = node.values.map(value => {
        const suffix = value === '' ? 'Empty' : goName(value, schema)
        const constant = claim(name + suffix, schema + ':' + value, schema)
        return `\t${constant} ${name} = ${JSON.stringify(value)}`
      })
      definitions.set(name, `type ${name} string\n\nconst (\n${constants.join('\n')}\n)\n`)
    }
    return name
  }
  for (const entry of roots) {
    const name = rootNames.get(entry.id)
    const underlying = typeOf(entry.runtime.root, name, entry.id, name)
    if (underlying !== name) definitions.set(name, `type ${name} = ${underlying}\n`)
  }
  const helpers = roots.map(entry => {
    const name = rootNames.get(entry.id)
    return `const ${name}SchemaID = ${JSON.stringify(entry.id)}\n\n` +
      `func Parse${name}(registry *Registry, data json.RawMessage) (${name}, error) {\n\tvar value ${name}\n\terr := registry.Decode(${name}SchemaID, data, &value)\n\treturn value, err\n}\n\n` +
      `func Validate${name}(registry *Registry, value ${name}) error {\n\treturn registry.Validate(${name}SchemaID, value)\n}\n`
  })
  const source = '// Code generated from selected @foreman-code/contracts execution descriptors. DO NOT EDIT.\n' +
    '// Source identities are recorded in schemas.json; generation is not parity qualification.\npackage contracts\n\n' +
    'import (\n\t_ "embed"\n\t"encoding/json"\n)\n\n' +
    '//go:embed schemas.json\nvar generatedSchemaManifest []byte\n\n' +
    'func NewGeneratedRegistry() (*Registry, error) { return NewRegistry(generatedSchemaManifest) }\n\n' +
    [...definitions.values(), ...helpers].join('\n')
  return { source, schemas: JSON.stringify(manifest, null, 2) + '\n', selected: roots.map(entry => entry.id) }
}

async function main(args) {
  const options = { selected: [] }
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!['--manifest', '--output-dir', '--select'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) fail('usage', 'Use --manifest <manifest.json> --output-dir <isolated-package-dir> --select <exact-schema-id> (repeat selection)')
    const value = args[++index]
    if (key === '--select') options.selected.push(value)
    else if (own(options, key)) fail('usage', `Duplicate option ${key}`)
    else options[key] = value
  }
  if (!options['--manifest'] || !options['--output-dir'] || !options.selected.length) fail('usage', 'Explicit manifest, isolated output directory and schema selections are required')
  const manifest = JSON.parse(await readFile(resolve(options['--manifest']), 'utf8'))
  const output = generateGoContracts({ manifest, selected: options.selected })
  const directory = resolve(options['--output-dir'])
  await mkdir(directory, { recursive: true })
  // Admission completes before either output is written. The terminal owns
  // atomic integration of this pair into its candidate, followed by Go gates.
  for (const [name, content] of [['schemas.json', output.schemas], ['generated.go', output.source]]) {
    const temporary = resolve(directory, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, resolve(directory, name))
  }
  process.stdout.write(JSON.stringify({ status: 'authored-output', selected: output.selected,
    qualification: 'requires-actual-terminal-generated-Go-and-frozen-vector-evidence' }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write(JSON.stringify(error instanceof GenerationError ? error.diagnostic : { code: 'generation-failed', detail: String(error?.message ?? error), path: [] }) + '\n')
    process.exitCode = 1
  }
}
