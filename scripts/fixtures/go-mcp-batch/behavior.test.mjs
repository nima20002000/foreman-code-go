import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runNativeProbe } from '../go-ci-acceptance/run-native.mjs'

test('MCP batch adapter propagates selected public protocol behavior', async () => {
  assert.equal(await runNativeProbe(import.meta.url, 'mcp-batch-behavior'), 0)
})
