// These public CLI regressions run only in terminal Foreman CI. The terminal
// supplies actual, narrowly compiled source modules; this test invokes no build.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const producer = resolve(root, 'scripts/go-contracts/auth-vectors.mjs')
const frozenReference = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const mergedBase = '7fa547058109519a99c904493c916662fde6a474'
const baseTree = '4940336b1b5038d1b14a3add25118e13ed8aa121'

function requiredPath(name) {
  const value = process.env[name]
  assert.ok(value, `${name} must identify a real terminal-prepared fixture; this gate cannot skip`)
  return resolve(value)
}

function revision(expression) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', expression], { encoding: 'utf8' })
  assert.equal(result.status, 0, `Cannot read actual candidate Git identity: ${result.stderr}`)
  assert.match(result.stdout.trim(), /^[0-9a-f]{40}$/)
  return result.stdout.trim()
}

async function context(label) {
  const directory = await mkdtemp(join(tmpdir(), `foreman-auth-capture-${label}-`))
  const home = join(directory, 'home')
  await mkdir(home)
  return {
    directory, home,
    frozenRoot: requiredPath('AUTH_VECTOR_FROZEN_ROOT'),
    frozenCompiled: requiredPath('AUTH_VECTOR_FROZEN_COMPILED_DIR'),
    candidateCompiled: requiredPath('AUTH_VECTOR_CANDIDATE_COMPILED_DIR'),
    candidate: revision('HEAD^{commit}'), tree: revision('HEAD^{tree}'),
  }
}

function invoke(fixture, options = {}) {
  const output = join(fixture.directory, options.output ?? 'capture.json')
  const result = spawnSync(process.env.AUTH_VECTOR_RUNTIME ?? process.execPath, [producer,
    fixture.frozenRoot, options.frozenCompiled ?? fixture.frozenCompiled,
    options.candidateCompiled ?? fixture.candidateCompiled,
    options.candidate ?? fixture.candidate, options.tree ?? fixture.tree, output], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, HOME: fixture.home, XDG_STATE_HOME: join(fixture.directory, 'state'),
      XDG_CONFIG_HOME: join(fixture.directory, 'config'), XDG_CACHE_HOME: join(fixture.directory, 'cache') },
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, 'The CLI must finish naturally')
  return { ...result, output }
}

test('auth.capture.source-provenance', async () => {
  const fixture = await context('provenance')
  assert.notEqual(fixture.candidate, mergedBase, 'Run against the authored candidate, not the skeleton')
  assert.notEqual(fixture.tree, baseTree)
  for (const mismatch of [
    { candidate: mergedBase, output: 'wrong-candidate.json' },
    { tree: baseTree, output: 'wrong-tree.json' },
  ]) {
    const result = invoke(fixture, mismatch)
    assert.notEqual(result.status, 0, 'A syntactically valid but false source identity must be rejected')
    assert.match(result.stderr + result.stdout, /candidate|tree|provenance/i,
      'The public diagnostic must identify the provenance boundary')
  }
})

async function throwingModules(destination, actual, includeHelper) {
  // This is an intentionally invalid producer fixture. It is never a substitute
  // for TS/Go contract qualification or a terminal compilation receipt.
  await mkdir(join(destination, 'management'), { recursive: true })
  await mkdir(join(destination, 'node_modules'), { recursive: true })
  await writeFile(join(destination, 'package.json'), JSON.stringify({ type: 'module',
    private: true, description: 'negative auth capture CLI fixture; not compiled source evidence' }))
  const url = pathToFileURL(resolve(actual, 'schemaPrimitives.js')).href
  await writeFile(join(destination, 'schemaPrimitives.js'),
    `export * from ${JSON.stringify(url)}\n` +
    'export const IdSchema = { safeParse() { throw new Error("intentional auth capture negative fixture") } }\n')
  await writeFile(join(destination, 'management/principals.js'),
    `export * from ${JSON.stringify(pathToFileURL(resolve(actual, 'management/principals.js')).href)}\n`)
  if (includeHelper) {
    await writeFile(join(destination, 'goContractRules.js'),
      `export * from ${JSON.stringify(pathToFileURL(resolve(actual, 'goContractRules.js')).href)}\n`)
  }
  const require = createRequire(pathToFileURL(resolve(actual, 'schemaPrimitives.js')))
  const zodRoot = dirname(require.resolve('zod/package.json'))
  await symlink(zodRoot, join(destination, 'node_modules/zod'), 'dir')
  return destination
}

test('auth.capture.identical-throws', async () => {
  const fixture = await context('throws')
  const frozenCompiled = await throwingModules(join(fixture.directory, 'negative-frozen'), fixture.frozenCompiled, false)
  const candidateCompiled = await throwingModules(join(fixture.directory, 'negative-candidate'), fixture.candidateCompiled, true)
  const result = invoke(fixture, { frozenCompiled, candidateCompiled })
  assert.notEqual(result.status, 0, 'Two equal unexpected throws must never make a capture successful')
  const evidence = JSON.parse(await readFile(result.output, 'utf8'))
  assert.equal(evidence.source.reference, frozenReference)
  assert.equal(evidence.vectors.length, 47, 'Every outcome must be retained even when schemas throw')
  assert.deepEqual(evidence.mismatches, [], 'The negative fixtures throw identically on both sides')
  const thrown = evidence.vectors.filter(vector => vector.frozen.threw || vector.candidate.threw)
  assert.equal(thrown.length, 11)
  assert.deepEqual(evidence.thrown, thrown.map(vector => vector.id))
  assert.ok(thrown.every(vector => vector.frozen.threw && vector.candidate.threw))
  assert.ok(evidence.failures.includes('unexpected-schema-throw'))
  assert.notEqual(evidence.qualification, 'qualified', 'Negative fixtures cannot become qualification receipts')
})
