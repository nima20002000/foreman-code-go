import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../go-ci-acceptance/run-native.mjs'

test('snapshot race adapter propagates selected Go behavior', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'snapshot-race'), 0)
})
