import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../../../scripts/fixtures/go-ci-acceptance/run-native.mjs'

test('health readiness adapter propagates the exact selected conformance targets', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'health-ready'), 0)
})
