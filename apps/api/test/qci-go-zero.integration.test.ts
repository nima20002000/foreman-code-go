import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../../../scripts/fixtures/go-ci-acceptance/run-native.mjs'

test('zero integration adapter propagates the real Go command with no matching named case', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'zero-integration'), 0)
})
