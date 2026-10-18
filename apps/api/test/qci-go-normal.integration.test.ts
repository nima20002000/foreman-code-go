import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../../../scripts/fixtures/go-ci-acceptance/run-native.mjs'

test('normal integration adapter propagates the real selected Go round-trip action', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'normal-integration'), 0)
})
