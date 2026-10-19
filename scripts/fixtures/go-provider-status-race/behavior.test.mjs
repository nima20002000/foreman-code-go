import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../go-ci-acceptance/run-native.mjs'

test('provider status race adapter propagates selected Go behavior', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'provider-status-race'), 0)
})
