import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from './run-native.mjs'

test('assertion-fail adapter propagates the real selected Go assertion failure', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'assertion-fail'), 0)
})
