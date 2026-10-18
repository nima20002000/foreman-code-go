import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from './run-native.mjs'

test('normal adapter propagates the real selected Go round-trip action', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'normal'), 0)
})
