import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../go-ci-acceptance/run-native.mjs'

test('device tls adapter propagates selected Go behavior', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'device-tls'), 0)
})
