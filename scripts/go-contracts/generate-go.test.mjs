// Public CLI cases only. Positive DTO/validator qualification is the compiled
// Go behavior gate, not source-string assertions in these tests.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
