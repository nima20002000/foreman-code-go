// Execute only in terminal Foreman CI after the explicitly affected source
// modules have been compiled there. This producer never invokes a compiler.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const reference = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const mergedBase = '7fa547058109519a99c904493c916662fde6a474'
const originals = [
  ['packages/contracts/src/operationalFailures.ts', 'c65d6160be2ce1017d326501a48056a885aa85d5'],
]
const args = process.argv.slice(2)
if (args.length !== 6 || !/^[0-9a-f]{40}$/.test(args[3]) || !/^[0-9a-f]{40}$/.test(args[4])) {
  throw new Error('Usage: node scripts/go-contracts/operational-vectors.mjs <frozen-source-root> <frozen-compiled-dir> <candidate-compiled-dir> <candidate-commit-sha> <candidate-tree-sha> <output.json>')
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

function gitIdentity(root, expression) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--verify', expression], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Invalid Git provenance for ' + expression)
  return value
}

function verifySourceFiles(root, revision, files) {
  for (const file of files) {
    if (gitIdentity(root, revision + ':' + file.path) !== file.blob) {
      throw new Error('Source provenance differs from declared Git tree at ' + file.path)
    }
  }
}

const frozenCommit = gitIdentity(frozenRoot, 'HEAD^{commit}')
const frozenTree = gitIdentity(frozenRoot, 'HEAD^{tree}')
if (frozenCommit !== reference) throw new Error('Frozen source HEAD differs from required reference ' + reference)
const actualCandidate = gitIdentity(candidateRoot, 'HEAD^{commit}')
const actualTree = gitIdentity(candidateRoot, 'HEAD^{tree}')
if (actualCandidate !== candidate) throw new Error('Candidate provenance differs from actual HEAD: ' + actualCandidate)
if (actualTree !== tree) throw new Error('Candidate tree provenance differs from actual HEAD tree: ' + actualTree)

const dependencyInputs = ['packages/contracts/package.json', 'packages/contracts/tsconfig.json', 'pnpm-lock.yaml']
const frozenSources = await sourceIdentity(frozenRoot, [...originals.map(([path]) => path), ...dependencyInputs])
for (let index = 0; index < originals.length; index++) {
  if (frozenSources[index].blob !== originals[index][1]) {
    throw new Error('Frozen operational source differs at ' + originals[index][0] + ': ' + frozenSources[index].blob)
  }
}
const candidateSources = await sourceIdentity(candidateRoot, [
  ...originals.map(([path]) => path),
  'scripts/go-contracts/operational-vectors.mjs', ...dependencyInputs,
])
verifySourceFiles(frozenRoot, frozenCommit, frozenSources)
verifySourceFiles(candidateRoot, actualCandidate, candidateSources)

async function loadSchemas(directory) {
  const module = await import(pathToFileURL(resolve(directory, 'operationalFailures.js')).href)
  return new Map([['./operationalFailures#OperationalFailureSchema', module.OperationalFailureSchema]])
}

async function zodVersion(directory) {
  const require = createRequire(pathToFileURL(resolve(directory, 'operationalFailures.js')))
  const { version } = JSON.parse(await readFile(require.resolve('zod/package.json'), 'utf8'))
  if (version !== '4.6.3') throw new Error('Operational reference capture requires the pinned Zod 4.6.3')
  return version
}

const zod = { frozen: await zodVersion(frozenCompiled), candidate: await zodVersion(candidateCompiled) }
const frozenSchemas = await loadSchemas(frozenCompiled)
const candidateSchemas = await loadSchemas(candidateCompiled)
for (const [id, schema] of [...frozenSchemas, ...candidateSchemas]) {
  if (typeof schema?.safeParse !== 'function') throw new Error('Required actual shared schema is absent: ' + id)
}

const schema = './operationalFailures#OperationalFailureSchema'
const fixture = (overrides = {}) => ({ component: 'fixture', operation: 'poll', status: 'degraded', lastError: 'fixture failure',
  failureCount: 1, firstFailedAt: '2026-01-01T00:00:00Z', lastFailedAt: '2026-01-01T00:00:01Z', ...overrides })
const json = value => ({ json: JSON.stringify(value) })
const plain = (id, value) => ({ id: 'operational.' + id, schema, input: json(value) })
const change = (id, values) => plain(id, fixture(values))
const number = (id, field, token) => ({ id: 'operational.' + id, schema,
  input: { json: JSON.stringify(fixture({ [field]: 'NUMBER_TOKEN' })).replace('"NUMBER_TOKEN"', token) } })
const definitions = [
  plain('minimal', fixture()),
  change('all-optional', { nextRetryAt: '2026-01-01T00:00:02.123456789Z', attempt: 2, elapsedMs: 1.5,
    dataAgeMs: 0, pendingBytes: 8, pendingSince: '2026-01-01T00:00:01Z', selectedSource: 'fixture' }),
  change('nullable', { dataAgeMs: null, pendingBytes: null, pendingSince: null }),
  change('plain-strings', { component: '', operation: ' \ufeff ', lastError: '\ud800', selectedSource: '\udc00' }),
  plain('root-null', null), plain('root-array', []), plain('missing-required', {}),
  change('wrong-status', { status: 'healthy' }), change('unknown-key', { unexpected: true }),
  change('wrong-type', { component: 1, operation: false, lastError: null }),
  number('failure-count-zero', 'failureCount', '0'), number('failure-count-negative', 'failureCount', '-1'),
  number('failure-count-fraction', 'failureCount', '1.5'), number('failure-count-safe-max', 'failureCount', '9007199254740991'),
  number('failure-count-unsafe', 'failureCount', '9007199254740992'), number('failure-count-equivalent', 'failureCount', '1.0e0'),
  number('failure-count-negative-zero', 'failureCount', '-0'), number('failure-count-infinite', 'failureCount', '1e400'),
  number('attempt-negative', 'attempt', '-1'), number('attempt-negative-zero', 'attempt', '-0'),
  change('attempt-null', { attempt: null }), number('elapsed-fraction', 'elapsedMs', '0.125'),
  number('elapsed-negative', 'elapsedMs', '-0.1'), number('elapsed-negative-zero', 'elapsedMs', '-0'),
  number('elapsed-underflow', 'elapsedMs', '1e-400'), number('elapsed-infinite', 'elapsedMs', '1e400'),
  number('pending-bytes-fraction', 'pendingBytes', '0.5'), number('pending-bytes-unsafe', 'pendingBytes', '9007199254740992'),
  change('source-80-astral', { selectedSource: '😀'.repeat(80) }), change('source-81-astral', { selectedSource: '😀'.repeat(81) }),
  change('source-80-lone', { selectedSource: '\ud800'.repeat(80) }), change('source-81-bmp', { selectedSource: 'a'.repeat(81) }),
  change('datetime-leap', { firstFailedAt: '2024-02-29T23:59:59Z' }), change('datetime-invalid-date', { lastFailedAt: '2026-02-29T00:00:00Z' }),
  change('datetime-offset-forbidden', { nextRetryAt: '2026-01-01T00:00:00+00:00' }),
  change('datetime-minute-forbidden', { nextRetryAt: '2026-01-01T00:00Z' }),
  change('datetime-newline-forbidden', { pendingSince: '2026-01-01T00:00:00Z\n' }),
  change('multiple-issues-order', { component: 1, status: 'ready', failureCount: 0, nextRetryAt: null, pendingBytes: -1, selectedSource: 'a'.repeat(81), unknown: true }),
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
const thrown = vectors.filter(vector => vector.frozen.threw || vector.candidate.threw).map(vector => vector.id)
const compiledFiles = ['operationalFailures.js']
const compiled = {
  frozen: await sourceIdentity(frozenCompiled, compiledFiles),
  candidate: await sourceIdentity(candidateCompiled, compiledFiles),
}

async function compilationEvidence() {
  const input = process.env.OPERATIONAL_CONTRACT_COMPILATION_EVIDENCE_FILE
  if (!input) return { errors: ['OPERATIONAL_CONTRACT_COMPILATION_EVIDENCE_FILE is required'], record: null }
  try {
    const bytes = await readFile(resolve(input))
    const supplied = JSON.parse(bytes.toString('utf8'))
    const errors = []
    if (supplied.schemaVersion !== 1 || supplied.ticket?.provider !== 'foreman-ci' ||
        typeof supplied.ticket?.id !== 'string' || !supplied.ticket.id.trim() ||
        supplied.ticket?.scenario !== 'contracts.operational.compile.frozen-candidate') {
      errors.push('Actual Foreman CI compilation ticket identity is required')
    }
    if (supplied.source?.reference !== reference || supplied.source?.frozenTree !== frozenTree ||
        supplied.source?.candidate !== candidate || supplied.source?.tree !== tree) {
      errors.push('Compilation evidence source identity differs from checked source')
    }
    if (!Array.isArray(supplied.commands) || !supplied.commands.length ||
        supplied.commands.some(command => !Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string'))) {
      errors.push('Actual narrowly scoped compilation command arguments are required')
    }
    if (typeof supplied.runtime?.executable !== 'string' || typeof supplied.runtime?.versions !== 'object' || !supplied.runtime.versions) {
      errors.push('Actual compiler runtime executable and versions are required')
    }
    for (const side of ['frozen', 'candidate']) {
      const files = supplied.compiled?.[side]
      if (!Array.isArray(files) || files.length !== compiled[side].length ||
          compiled[side].some(file => files.filter(item => item?.path === file.path && item?.sha256 === file.sha256).length !== 1)) {
        errors.push('Compilation evidence module digests differ for ' + side)
      }
    }
    return { errors, record: { path: resolve(input), sha256: createHash('sha256').update(bytes).digest('hex'), supplied } }
  } catch (error) {
    return { errors: ['Cannot read compilation evidence: ' + (error instanceof Error ? error.message : String(error))], record: null }
  }
}

const compilation = await compilationEvidence()
const failures = [
  ...(mismatches.length ? ['behavior-parity-mismatch'] : []),
  ...(thrown.length ? ['unexpected-schema-throw'] : []),
  ...(compilation.errors.length ? ['compilation-provenance-unverified'] : []),
]
const bun = globalThis.Bun
const runtime = {
  executable: process.execPath, argv0: process.argv0, platform: process.platform, arch: process.arch,
  versions: { ...process.versions },
  bun: bun ? { version: bun.version ?? null, revision: bun.revision ?? null } : null,
  javascriptCore: process.versions.webkit ?? process.versions.jsc ?? null,
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  source: {
    package: '@foreman-code/contracts', reference, mergedBase,
    frozen: { reference: frozenCommit, tree: frozenTree, files: frozenSources },
    candidate: { reference: actualCandidate, tree: actualTree, files: candidateSources },
  },
  compiled, compilation, zod, producer: { script: 'scripts/go-contracts/operational-vectors.mjs', runtime },
  qualification: 'capture-only; independent terminal ticket verification required',
  vectors, mismatches, thrown, failures,
}, null, 2) + '\n')
process.stdout.write(JSON.stringify({ output, reference, candidate, tree, vectors: vectors.length, mismatches, thrown, failures }) + '\n')
// A supplied ticket label cannot prove execution. The terminal/controller must
// verify the real ticket and its artifacts independently. Every available schema
// outcome is retained before any parity, throw, or compilation-record failure.
if (failures.length !== 0) process.exitCode = 1
