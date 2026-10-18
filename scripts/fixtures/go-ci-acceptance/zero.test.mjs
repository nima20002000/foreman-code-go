import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from './run-native.mjs'

test('zero adapter propagates the real Go command with no matching named case', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'zero'), 0)
})
