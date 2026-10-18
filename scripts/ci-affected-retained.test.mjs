import assert from 'node:assert/strict'
import { test } from 'node:test'
import { affectedCommands } from './ci-affected-run.mjs'

test('affected script checks run only the selected Node test files', () => {
  assert.deepEqual(affectedCommands('unit', ['scripts/ci-selection.test.mjs', 'scripts/ci-affected.test.mjs']), [
    [process.execPath, '--test', 'scripts/ci-selection.test.mjs'],
    [process.execPath, '--test', 'scripts/ci-affected.test.mjs'],
  ])
})

test('affected retained tests stay inside their selected package', () => {
  assert.deepEqual(affectedCommands('unit', ['packages/contracts/src/ciSelection.test.ts']), [
    ['corepack', 'pnpm', '--dir', 'packages/contracts', 'exec', 'vitest', 'run', 'src/ciSelection.test.ts'],
  ])
  assert.deepEqual(affectedCommands('unit', ['conformance/src/reporting/report.test.ts']), [
    ['corepack', 'pnpm', '--dir', 'conformance', 'exec', 'vitest', 'run', 'src/reporting/report.test.ts'],
  ])
})

test('an empty explicit test selection runs no commands', () => {
  for (const suite of ['typecheck', 'lint', 'unit', 'integration', 'build']) {
    assert.deepEqual(affectedCommands(suite, []), [])
  }
})

test('unsupported nonempty selections fail before any suite can broaden', () => {
  for (const file of ['backend/internal/config/config_test.go', 'apps/api/src/value.test.ts',
    'apps/worker/src/value.test.mjs', 'scripts/ci-selection.mjs', 'README.md']) {
    assert.throws(() => affectedCommands('unit', [file]), /Unsupported affected|Unit scope requires/)
  }
  assert.throws(() => affectedCommands('integration', ['conformance/src/reporting/report.test.ts']),
    /committed native adapter binding/)
  assert.throws(() => affectedCommands('build', ['packages/contracts/src/ci.ts']), /explicit release scope/)
})
