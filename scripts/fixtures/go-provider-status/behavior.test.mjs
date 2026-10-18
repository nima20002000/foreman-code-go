import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../go-ci-acceptance/run-native.mjs'

test('provider status adapter propagates the selected Go behavior', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'provider-status-behavior'), 0)
})
