import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runActionProbe } from './run-native.mjs'

test('typecheck-api maps to bounded real Go build and vet actions', async () => {
  assert.equal(await runActionProbe(import.meta.url, 'typecheck-api', 'scripts/fixtures/go-ci-acceptance/check-plan.json'), 0)
})
