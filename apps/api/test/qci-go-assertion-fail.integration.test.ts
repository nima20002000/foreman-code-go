import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../../../scripts/fixtures/go-ci-acceptance/run-native.mjs'

test('assertion-fail integration adapter propagates the real selected Go assertion failure', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'assertion-fail-integration'), 0)
})
