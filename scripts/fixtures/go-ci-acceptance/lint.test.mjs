import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runActionProbe } from './run-native.mjs'

test('lint-api maps to bounded real Go formatting and Staticcheck actions', async () => {
  assert.equal(await runActionProbe(import.meta.url, 'lint-api', 'scripts/fixtures/go-ci-acceptance/check-plan.json'), 0)
})
