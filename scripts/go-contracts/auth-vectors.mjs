// Execute only in terminal Foreman CI after the explicitly affected source
// modules have been compiled there. This producer never invokes a compiler.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const reference = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const mergedBase = '7fa547058109519a99c904493c916662fde6a474'
const originals = [
  ['packages/contracts/src/schemaPrimitives.ts', '244b75ca295c378f8083bcc348e2c934017a3e6c'],
  ['packages/contracts/src/management/principals.ts', '207fd2bc00afb2f4bac73dc7b2ad021e56368098'],
]
const args = process.argv.slice(2)
if (args.length !== 6 || !/^[0-9a-f]{40}$/.test(args[3]) || !/^[0-9a-f]{40}$/.test(args[4])) {
  throw new Error('Usage: node scripts/go-contracts/auth-vectors.mjs <frozen-source-root> <frozen-compiled-dir> <candidate-compiled-dir> <candidate-commit-sha> <candidate-tree-sha> <output.json>')
}
const [frozenRoot, frozenCompiled, candidateCompiled, candidate, tree, outputArg] = args
const candidateRoot = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(outputArg)

function blob(bytes) {
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
}

async function sourceIdentity(root, paths) {
  return Promise.all(paths.map(async path => {
    const bytes = await readFile(resolve(root, path))
    return { path, blob: blob(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
}

const frozenSources = await sourceIdentity(frozenRoot, originals.map(([path]) => path))
for (let index = 0; index < originals.length; index++) {
  if (frozenSources[index].blob !== originals[index][1]) {
    throw new Error('Frozen auth source differs at ' + originals[index][0] + ': ' + frozenSources[index].blob)
  }
}
const candidateSources = await sourceIdentity(candidateRoot, [
  ...originals.map(([path]) => path), 'packages/contracts/src/goContractRules.ts',
  'scripts/go-contracts/auth-vectors.mjs',
])

async function loadSchemas(directory) {
  const primitives = await import(pathToFileURL(resolve(directory, 'schemaPrimitives.js')).href)
  const principals = await import(pathToFileURL(resolve(directory, 'management/principals.js')).href)
  return new Map([
    ['.#IdSchema', primitives.IdSchema],
    ['./management#ManagementActionSchema', principals.ManagementActionSchema],
    ['./management#ManagementGrantSchema', principals.ManagementGrantSchema],
    ['./management#ManagementPrincipalSchema', principals.ManagementPrincipalSchema],
  ])
}

async function zodVersion(directory) {
  const require = createRequire(pathToFileURL(resolve(directory, 'schemaPrimitives.js')))
  const { version } = JSON.parse(await readFile(require.resolve('zod/package.json'), 'utf8'))
  if (version !== '4.6.3') throw new Error('Auth reference capture requires the pinned Zod 4.6.3')
  return version
}

const zod = { frozen: await zodVersion(frozenCompiled), candidate: await zodVersion(candidateCompiled) }
const frozenSchemas = await loadSchemas(frozenCompiled)
const candidateSchemas = await loadSchemas(candidateCompiled)
for (const [id, schema] of [...frozenSchemas, ...candidateSchemas]) {
  if (typeof schema?.safeParse !== 'function') throw new Error('Required actual shared schema is absent: ' + id)
}

const idSchema = '.#IdSchema'
const actionSchema = './management#ManagementActionSchema'
const grantSchema = './management#ManagementGrantSchema'
const principalSchema = './management#ManagementPrincipalSchema'
const json = value => ({ json: JSON.stringify(value) })
const principal = (overrides = {}) => ({
  id: 'principal-fixture', name: 'Fixture operator', audience: 'operator',
  grants: [], expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null, ...overrides,
})
const without = (value, field) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))
const grant = scope => ({ actions: ['agents:read'], scope })
const definitions = [
  { id: 'auth.id.trim-ascii', schema: idSchema, input: json(' \t value \n') },
  { id: 'auth.id.trim-ecmascript', schema: idSchema, input: json('\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeffvalue\ufeff') },
  { id: 'auth.id.keep-nel', schema: idSchema, input: json('\u0085value\u0085') },
  { id: 'auth.id.keep-inner-whitespace', schema: idSchema, input: json('  two words  ') },
  { id: 'auth.id.empty', schema: idSchema, input: json('') },
  { id: 'auth.id.only-whitespace', schema: idSchema, input: json(' \t\n\ufeff') },
  { id: 'auth.id.null', schema: idSchema, input: json(null) },
  { id: 'auth.id.number', schema: idSchema, input: json(1) },
  { id: 'auth.id.supplementary', schema: idSchema, input: json(' 😀 ') },
  { id: 'auth.id.lone-surrogate', schema: idSchema, input: json(' \ud800 ') },
  { id: 'auth.id.undefined', schema: idSchema, input: { undefined: true } },
  { id: 'auth.action.known', schema: actionSchema, input: json('agents:read') },
  { id: 'auth.action.unknown', schema: actionSchema, input: json('agents:invented') },
  { id: 'auth.action.no-trim', schema: actionSchema, input: json(' agents:read ') },
  { id: 'auth.grant.empty-scope', schema: grantSchema, input: json(grant({})) },
  { id: 'auth.grant.trim-identifiers', schema: grantSchema, input: json(grant({ workspaceIds: [' w-1 '], workflowIds: [' f-1 '], runIds: [' r-1 '] })) },
  { id: 'auth.grant.no-actions', schema: grantSchema, input: json({ actions: [], scope: {} }) },
  { id: 'auth.grant.unknown-field', schema: grantSchema, input: json({ ...grant({}), unexpected: true }) },
  { id: 'auth.scope.unknown-field', schema: grantSchema, input: json(grant({ unexpected: true })) },
  { id: 'auth.scope.null-list', schema: grantSchema, input: json(grant({ workspaceIds: null })) },
  { id: 'auth.scope.list-500', schema: grantSchema, input: json(grant({ workspaceIds: Array.from({ length: 500 }, (_, index) => 'w-' + index) })) },
  { id: 'auth.scope.list-501', schema: grantSchema, input: json(grant({ workspaceIds: Array.from({ length: 501 }, (_, index) => 'w-' + index) })) },
  { id: 'auth.scope.uuid-values', schema: grantSchema, input: json(grant({ mainIds: ['a1b2c3d4-5678-4abc-8def-1234567890ab', '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'] })) },
  { id: 'auth.scope.uuid-uppercase', schema: grantSchema, input: json(grant({ deviceIds: ['A1B2C3D4-5678-4ABC-8DEF-1234567890AB'] })) },
  { id: 'auth.scope.uuid-invalid-variant', schema: grantSchema, input: json(grant({ mainIds: ['a1b2c3d4-5678-4abc-0def-1234567890ab'] })) },
  { id: 'auth.scope.uuid-no-trim', schema: grantSchema, input: json(grant({ mainIds: [' 00000000-0000-0000-0000-000000000000 '] })) },
  { id: 'auth.principal.operator', schema: principalSchema, input: json(principal()) },
  { id: 'auth.principal.user', schema: principalSchema, input: json(principal({ audience: 'user' })) },
  { id: 'auth.principal.worker-agent', schema: principalSchema, input: json(principal({ audience: 'worker', agentId: ' agent-1 ' })) },
  { id: 'auth.principal.worker-missing-agent', schema: principalSchema, input: json(principal({ audience: 'worker' })) },
  { id: 'auth.principal.worker-empty-agent', schema: principalSchema, input: json(principal({ audience: 'worker', agentId: '' })) },
  { id: 'auth.principal.worker-whitespace-agent', schema: principalSchema, input: json(principal({ audience: 'worker', agentId: ' \ufeff ' })) },
  { id: 'auth.principal.worker-null-agent', schema: principalSchema, input: json(principal({ audience: 'worker', agentId: null })) },
  { id: 'auth.principal.operator-agent-forbidden', schema: principalSchema, input: json(principal({ agentId: 'agent-1' })) },
  { id: 'auth.principal.user-agent-forbidden', schema: principalSchema, input: json(principal({ audience: 'user', agentId: 'agent-1' })) },
  { id: 'auth.principal.operator-whitespace-agent', schema: principalSchema, input: json(principal({ agentId: ' ' })) },
  { id: 'auth.principal.trim-readback', schema: principalSchema, input: json(principal({ id: ' principal-1 ', name: ' Fixture operator ', grants: [grant({ runIds: [' run-1 '] })] })) },
  { id: 'auth.principal.explicit-undefined-agent', schema: principalSchema, input: { ...json(principal()), undefinedFields: ['agentId'] } },
  { id: 'auth.principal.missing-revoked-at', schema: principalSchema, input: json(without(principal(), 'revokedAt')) },
  { id: 'auth.principal.unknown-field', schema: principalSchema, input: json(principal({ unexpected: true })) },
  { id: 'auth.principal.invalid-audience', schema: principalSchema, input: json(principal({ audience: 'device' })) },
  { id: 'auth.timestamp.offset', schema: principalSchema, input: json(principal({ expiresAt: '2026-01-01T12:34:56+02:30' })) },
  { id: 'auth.timestamp.compact-offset', schema: principalSchema, input: json(principal({ expiresAt: '2026-01-01T12:34:56+0230' })) },
  { id: 'auth.timestamp.minute-precision', schema: principalSchema, input: json(principal({ expiresAt: '2026-01-01T12:34Z' })) },
  { id: 'auth.timestamp.leap-day', schema: principalSchema, input: json(principal({ revokedAt: '2024-02-29T00:00:00Z' })) },
  { id: 'auth.timestamp.invalid-date', schema: principalSchema, input: json(principal({ expiresAt: '2026-02-29T00:00:00Z' })) },
  { id: 'auth.timestamp.trailing-newline', schema: principalSchema, input: json(principal({ expiresAt: '2026-01-01T00:00:00Z\n' })) },
]

function materialize(input) {
  if (input.undefined === true) return undefined
  const value = JSON.parse(input.json)
  for (const field of input.undefinedFields ?? []) value[field] = undefined
  return value
}

// Keep missing versus explicit undefined and every UTF-16 code unit visible.
function readback(value) {
  if (value === undefined) return { kind: 'undefined' }
  if (value === null) return { kind: 'null' }
  if (typeof value === 'string') {
    return { kind: 'string', units: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)) }
  }
  if (Array.isArray(value)) return { kind: 'array', items: value.map(readback) }
  if (typeof value === 'object') {
    return { kind: 'object', members: Object.keys(value).sort().map(key => ({ key, value: readback(value[key]) })) }
  }
  return { kind: typeof value, value: Object.is(value, -0) ? '-0' : String(value) }
}

function capture(schema, input) {
  try {
    const result = schema.safeParse(materialize(input))
    if (!result.success) return { accepted: false, issues: result.error.issues }
    return { accepted: true, value: readback(result.data), json: JSON.stringify(result.data) }
  } catch (error) {
    return { threw: error instanceof Error ? { name: error.name, message: error.message } : { value: readback(error) } }
  }
}

const vectors = definitions.map(definition => {
  const frozen = capture(frozenSchemas.get(definition.schema), definition.input)
  const proposed = capture(candidateSchemas.get(definition.schema), definition.input)
  return {
    ...definition, goApplicable: typeof definition.input.json === 'string' && !definition.input.undefinedFields,
    frozen, candidate: proposed, parity: isDeepStrictEqual(frozen, proposed),
  }
})
const mismatches = vectors.filter(vector => !vector.parity).map(vector => vector.id)
const compiledFiles = ['schemaPrimitives.js', 'management/principals.js']
const compiled = {
  frozen: await sourceIdentity(frozenCompiled, compiledFiles),
  candidate: await sourceIdentity(candidateCompiled, [...compiledFiles, 'goContractRules.js']),
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  source: {
    package: '@foreman-code/contracts', reference, mergedBase,
    frozen: { reference, files: frozenSources }, candidate: { reference: candidate, tree, files: candidateSources },
  },
  compiled, zod, producer: { script: 'scripts/go-contracts/auth-vectors.mjs', node: process.version },
  vectors, mismatches,
}, null, 2) + '\n')
process.stdout.write(JSON.stringify({ output, reference, candidate, tree, vectors: vectors.length, mismatches }) + '\n')
// Complete readbacks and failures are retained before a parity mismatch fails CI.
if (mismatches.length !== 0) process.exitCode = 1
