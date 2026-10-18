// Public CLI cases only. Positive DTO/validator qualification is the compiled
// Go behavior gate, not source-string assertions in these tests.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./generate-go.mjs', import.meta.url))
function invoke(args) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 }) }
function diagnostics(result) {
  assert.equal(result.error, undefined, 'CLI setup must succeed before a behavior assertion')
  return result.stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function actualManifest() {
  assert.ok(process.env.GO_CONTRACT_MANIFEST_FILE, 'unmet setup: terminal must supply the actual affected execution export')
  return JSON.parse(await readFile(process.env.GO_CONTRACT_MANIFEST_FILE, 'utf8'))
}
async function withManifest(action, mutate) {
  const manifest = await actualManifest()
  if (mutate) mutate(manifest)
  const directory = await mkdtemp(join(tmpdir(), 'foreman-codegen-cli-'))
  try {
    const source = join(directory, 'manifest.json')
    await writeFile(source, JSON.stringify(manifest))
    return await action(['--manifest', source, '--output-dir', join(directory, 'output'),
      ...manifest.coverage.selected.flatMap(id => ['--select', id])])
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('contracts.codegen.requires-explicit-selection', () => {
  const result = invoke([])
  assert.equal(result.status, 1)
  assert.equal(diagnostics(result)[0].code, 'usage')
})

test('contracts.codegen.requires-execution-policy', async () => {
  await withManifest(args => {
    const result = invoke(args)
    assert.equal(result.status, 1)
    assert.equal(diagnostics(result)[0].code, 'execution-policy')
  }, manifest => { delete manifest.validation.execution })
})

test('contracts.codegen.rejects-unsupported-node', async () => {
  await withManifest(args => {
    const result = invoke(args)
    assert.equal(result.status, 1)
    assert.equal(diagnostics(result)[0].code, 'unsupported-node')
    assert.deepEqual(diagnostics(result)[0].path, ['runtime', 'root'])
  }, manifest => { manifest.schemas[0].runtime.root = { kind: 'transform', checks: [] } })
})

test('contracts.codegen.selected-output', async () => {
  await withManifest(args => {
    const result = invoke(args)
    assert.equal(result.error, undefined, 'CLI setup must succeed before the public generation assertion')
    assert.equal(result.status, 0, 'selected supported source descriptors must reach authored output: ' + result.stderr)
    const output = JSON.parse(result.stdout.trim())
    assert.equal(output.status, 'authored-output')
    assert.equal(output.qualification, 'requires-actual-terminal-generated-Go-and-frozen-vector-evidence')
    assert.deepEqual(output.selected, args.flatMap((arg, index) => arg === '--select' ? [args[index + 1]] : []).sort())
    // This assertion establishes CLI behavior only. It does not inspect emitted
    // source or qualify generated Go types, schemas, validators or parity.
  })
})

test('contracts.codegen.codepoint-fixture', async () => {
  // This is an explicit test-only root in a separate terminal output candidate.
  // It is never added to shared production contracts or their default export.
  const original = await actualManifest()
  const output = process.env.GO_CONTRACT_LENGTH_EXPORT_DIR
  assert.ok(output, 'unmet setup: a fresh terminal output directory is required')
  const exporter = await import('./export-schemas.mjs')
  const binding = exporter.installDefaultExecutionPolicy()
  const contractsRequire = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))
  const packageFile = contractsRequire.resolve('zod/package.json')
  const packageBytes = await readFile(packageFile)
  const metadata = JSON.parse(packageBytes)
  assert.equal(metadata.version, '4.6.3')
  const moduleFile = resolve(dirname(packageFile), metadata.exports['.'].import)
  const { z } = await import(pathToFileURL(moduleFile).href)
  const CodePointLengthOneSchema = z.string().max(1)
  const id = './test-fixture#CodePointLengthOneSchema'
  const extra = exporter.exportContractSchemas({
    modules: new Map([['./test-fixture', { CodePointLengthOneSchema }]]),
    selected: [{ module: './test-fixture', export: 'CodePointLengthOneSchema' }], source: original.source,
    execution: 'zod-default-en', executionPolicy: binding,
  })
  assert.deepEqual(extra.unsupported, [])
  assert.equal(extra.schemas.length, 1)
  const vectors = [
    ['contracts.length.empty', ''], ['contracts.length.bmp-one', 'a'], ['contracts.length.bmp-two', 'ab'],
    ['contracts.length.astral-one', '\ud83d\ude00'], ['contracts.length.lone-high', '\ud800'], ['contracts.length.lone-low', '\udc00'],
  ].map(([name, value]) => {
    let outcome
    try {
      const result = CodePointLengthOneSchema.safeParse(value)
      outcome = result.success ? { accepted: true,
        value: { kind: 'string', units: Array.from({ length: result.data.length }, (_, index) => result.data.charCodeAt(index)) },
        json: JSON.stringify(result.data) } : { accepted: false, issues: result.error.issues }
    } catch (error) { outcome = { threw: { name: error?.name, message: String(error?.message ?? error) } } }
    return { id: name, schema: id, input: { json: JSON.stringify(value) }, goApplicable: true, frozen: outcome }
  })
  const manifest = structuredClone(original)
  manifest.schemas.push(...extra.schemas)
  for (const key of ['selected', 'exported', 'discovered']) manifest.coverage[key].push(id)
  for (const key of ['selected', 'exported', 'discovered']) manifest.coverage.counts[key] = manifest.coverage[key].length
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'length-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(output, 'length-vectors.json'), JSON.stringify({ schemaVersion: 1, schema: id,
    source: original.source, producer: { script: 'scripts/go-contracts/generate-go.test.mjs',
      sha256: digest(await readFile(fileURLToPath(import.meta.url))), executable: process.execPath, versions: { ...process.versions } },
    zod: { version: metadata.version, packageSHA256: digest(packageBytes), moduleFile, moduleSHA256: digest(await readFile(moduleFile)) },
    qualification: 'test-fixture capture only; generator and compiled Go behavior ticket still required', vectors,
  }, null, 2) + '\n')
  assert.deepEqual(vectors.filter(vector => vector.frozen.threw).map(vector => vector.id), [], 'all outcomes were retained before this unexpected-throw gate')
})

test('contracts.pattern.posix-fixture', async () => {
  const original = await actualManifest()
  const output = process.env.GO_CONTRACT_POSIX_EXPORT_DIR
  assert.ok(output, 'unmet setup: a fresh terminal POSIX probe output directory is required')
  const exporter = await import('./export-schemas.mjs')
  const binding = exporter.installDefaultExecutionPolicy()
  const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))
  const packageFile = requireContracts.resolve('zod/package.json')
  const packageBytes = await readFile(packageFile)
  const metadata = JSON.parse(packageBytes)
  assert.equal(metadata.version, '4.6.3')
  const moduleFile = resolve(dirname(packageFile), metadata.exports['.'].import)
  const { z } = await import(pathToFileURL(moduleFile).href)
  const POSIXClassSchema = z.string().regex(/[[:digit:]]/)
  const id = './test-fixture#POSIXClassSchema'
  const manifest = exporter.exportContractSchemas({
    modules: new Map([['./test-fixture', { POSIXClassSchema }]]),
    selected: [{ module: './test-fixture', export: 'POSIXClassSchema' }], source: original.source,
    execution: 'zod-default-en', executionPolicy: binding,
  })
  assert.deepEqual(manifest.unsupported, [])
  assert.equal(manifest.schemas.length, 1)
  const vectors = ['7', 'd]', ':]', '7]', 'x'].map((value, index) => {
    let outcome
    try {
      const parsed = POSIXClassSchema.safeParse(value)
      outcome = parsed.success ? { accepted: true, json: JSON.stringify(parsed.data) } : { accepted: false, issues: parsed.error.issues }
    } catch (error) { outcome = { threw: { name: error?.name, message: String(error?.message ?? error) } } }
    return { id: 'contracts.pattern.posix-' + index, input: { json: JSON.stringify(value) }, frozen: outcome }
  })
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'posix-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(output, 'posix-vectors.json'), JSON.stringify({ schemaVersion: 1, schema: id, source: original.source,
    producer: { script: 'scripts/go-contracts/generate-go.test.mjs', sha256: digest(await readFile(fileURLToPath(import.meta.url))), executable: process.execPath, versions: { ...process.versions } },
    zod: { version: metadata.version, packageSHA256: digest(packageBytes), moduleFile, moduleSHA256: digest(await readFile(moduleFile)) },
    qualification: 'unsupported-pattern probe only; actual Go admission regression ticket required', vectors,
  }, null, 2) + '\n')
  assert.deepEqual(vectors.filter(vector => vector.frozen.threw).map(vector => vector.id), [], 'all source outcomes retained before unexpected-throw gate')
})

test('contracts.codegen.rejects-posix-pattern', () => {
  assert.ok(process.env.GO_CONTRACT_POSIX_MANIFEST_FILE, 'unmet setup: actual pinned-Zod POSIX fixture export is required')
  const result = invoke(['--manifest', process.env.GO_CONTRACT_POSIX_MANIFEST_FILE,
    '--output-dir', join(tmpdir(), 'foreman-posix-must-not-generate-' + process.pid), '--select', './test-fixture#POSIXClassSchema'])
  assert.equal(result.status, 1)
  assert.equal(diagnostics(result)[0].code, 'unsupported-pattern')
})
