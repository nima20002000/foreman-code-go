import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../go-ci-acceptance/run-native.mjs'

test('snapshot adapter propagates the selected Go snapshot behavior', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'snapshot-behavior'), 0)
})
