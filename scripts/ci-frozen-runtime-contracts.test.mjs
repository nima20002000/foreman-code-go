import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readAffectedRequest, validateAffectedSuite } from './ci-affected-scope.mjs'
import { frozenRuntimeFixture, referenceAdapter, referenceScenario } from './test-support/frozen-runtime-contracts-fixture.mjs'

function compiledWorkerResult(f) {
  const prepared = f.run()
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
  const imported = f.observe([
    "import { parseCiLock } from './apps/api/src/modules/jobs/ciRuntimeContext.mjs'",
    "import { workerResult } from './scripts/runtime-bridge.mjs'",
    "import { scenarioValue } from '@foreman-code/contracts/scenario'",
    "import { serverValue } from '@foreman-code/contracts/server'",
    "import { credentialsValue } from '@foreman-code/contracts/credentials'",
    "process.stdout.write(JSON.stringify({ lock: parseCiLock('name: fixture'), workerResult, scenarioValue, serverValue, credentialsValue }))",
  ].join('\n'))
  assert.equal(imported.status, 0, imported.stdout + imported.stderr)
  assert.deepEqual(JSON.parse(imported.stdout), { lock: { name: 'fixture' },
    workerResult: { code: 'fixture-worker', value: 6 }, scenarioValue: 3, serverValue: 4, credentialsValue: 5 })
}

test('explicit TS reference prepares contracts through real worker diagnostics and artifact dependencies', t => {
  compiledWorkerResult(frozenRuntimeFixture(t))
})

test('the existing explicit TS comparison retains the same runtime dependency closure', t => {
  const f = frozenRuntimeFixture(t)
  f.select(f.request({ conformanceTarget: undefined, conformanceTsRequired: true }))
  compiledWorkerResult(f)
})

test('an ordinary retained contract remains available beside the separately admitted TS runtime', t => {
  const f = frozenRuntimeFixture(t)
  f.put('scripts/retained.mjs', "export { retainedValue } from '@foreman-code/contracts/retained'\n")
  f.select(f.request({ files: [referenceScenario, 'scripts/retained.mjs'] }))
  compiledWorkerResult(f)
  const imported = f.observe("import { retainedValue } from './scripts/retained.mjs'\nprocess.stdout.write(String(retainedValue))\n")
  assert.equal(imported.status, 0, imported.stdout + imported.stderr)
  assert.equal(imported.stdout, '7')
})

test('a missing transitive worker runtime input is reported before contracts compilation', t => {
  const f = frozenRuntimeFixture(t, { compiler: false })
  f.remove('apps/worker/artifacts/ci-runtime/seed-policy.mjs')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cannot resolve selected dependency \.\/seed-policy\.mjs/)
})

test('a required worker contract compiler error remains a preparation failure', t => {
  const f = frozenRuntimeFixture(t)
  f.put('packages/contracts/src/worker.ts', 'export const workerValue: number = "invalid"\n')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /TS2322/)
})

for (const retainedFirst of [false, true]) {
  test(`an ordinary API dependency cannot borrow runtime admission when retained is ${retainedFirst ? 'first' : 'last'}`, t => {
    const f = frozenRuntimeFixture(t, { compiler: false })
    f.put('apps/api/src/server.ts', "import '../../../scripts/shared-api.mjs'\n")
    f.put('scripts/shared-api.mjs', "import '../apps/api/src/shared.ts'\n")
    f.put('apps/api/src/shared.ts', "import '@foreman-code/contracts/server'\n")
    const files = [referenceScenario, 'scripts/shared-api.mjs']
    if (retainedFirst) files.reverse()
    assert.throws(() => f.plan(f.request({ files })), /frozen TypeScript backend/)
  })
}

test('ordinary worker dependencies stay denied beside a TS reference in either selected order', t => {
  const f = frozenRuntimeFixture(t, { compiler: false })
  for (const files of [[referenceScenario, 'scripts/runtime-bridge.mjs'], ['scripts/runtime-bridge.mjs', referenceScenario]]) {
    assert.throws(() => f.plan(f.request({ files })), /frozen TypeScript backend/)
  }
})

test('ordinary retained requests cannot cross into API or worker runtime dependencies', t => {
  const f = frozenRuntimeFixture(t, { compiler: false })
  f.put('apps/api/src/shared.ts', 'export const value = 1\n')
  for (const dependency of ['../apps/api/src/shared.ts', '../apps/worker/src/diagnostics.mjs']) {
    f.put('scripts/retained.mjs', `import '${dependency}'\n`)
    assert.throws(() => f.plan({ files: ['scripts/retained.mjs'] }), /frozen TypeScript backend/)
  }
})

for (const file of ['apps/api/src/direct.ts', 'apps/worker/artifacts/direct.mjs']) {
  test(`the public preparation CLI rejects direct frozen input ${file} beside a TS reference`, t => {
    const f = frozenRuntimeFixture(t)
    f.put('apps/api/src/server.ts', 'export {}\n')
    f.put('apps/api/src/cli/operatorCredentials.ts', 'export {}\n')
    f.put(file, 'export const direct = true\n')
    f.select(f.request({ files: [referenceScenario, file] }))
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /frozen TypeScript backend/)
  })
}

test('an unbound API integration filename does not grant a direct frozen selection', t => {
  const f = frozenRuntimeFixture(t, { compiler: false })
  f.put(referenceAdapter, 'export {}\n')
  f.select({ files: [referenceAdapter] })
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /frozen TypeScript backend/)
})

test('direct frozen API and worker suite requests remain unsupported', t => {
  const f = frozenRuntimeFixture(t, { compiler: false })
  for (const file of ['apps/api/test/unbound.integration.test.ts', 'apps/worker/test/worker.test.mjs']) {
    f.put(file, 'export {}\n')
    for (const suite of ['unit', 'integration']) {
      assert.throws(() => validateAffectedSuite(suite, readAffectedRequest({ files: [file] }, f.root), f.root),
        /Unsupported affected file/)
    }
  }
})

test('a committed native integration adapter still prepares its own retained contract inputs', t => {
  const f = frozenRuntimeFixture(t)
  f.put(referenceAdapter, "import '@foreman-code/contracts/scenario'\n")
  f.put('conformance/selection.json', JSON.stringify(f.request()))
  f.put('scripts/ci-native-selectors.json', JSON.stringify({ [referenceAdapter]: {
    suite: 'integration', selection: 'conformance/selection.json',
  } }))
  f.select({ files: [referenceAdapter] })
  f.env.SUITE = 'integration'
  const prepared = f.run()
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
  const imported = f.observe("import { scenarioValue } from '@foreman-code/contracts/scenario'\nprocess.stdout.write(String(scenarioValue))\n")
  assert.equal(imported.status, 0, imported.stdout + imported.stderr)
  assert.equal(imported.stdout, '3')
})

test('Go-only conformance preparation does not traverse the frozen TS runtime', t => {
  const f = frozenRuntimeFixture(t)
  f.remove('apps/worker/artifacts/ci-runtime/seed-policy.mjs')
  f.select(f.request({ conformanceTarget: 'go' }))
  const prepared = f.run()
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
  const imported = f.observe("import { scenarioValue } from '@foreman-code/contracts/scenario'\nprocess.stdout.write(String(scenarioValue))\n")
  assert.equal(imported.status, 0, imported.stdout + imported.stderr)
  assert.equal(imported.stdout, '3')
})
