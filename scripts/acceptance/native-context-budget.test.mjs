import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCodexContextBudget } from './native-context-budget.mjs'

// Recorded observations test the verifier; only live native observations can qualify a budget.
function observations() {
  const context = { nativeSessionId: 'thread', source: 'codex', accuracy: 'native', stale: false,
    capacityTokens: 950000, lifetimeTokens: 2000 }
  const before = { nativeSessionId: 'thread', applied: { contextBudget: null },
    capabilities: { modelCapacity: 1000000 }, context }
  const after = { ...before, applied: { contextBudget: 500000 },
    context: { ...context, capacityTokens: 475000, lifetimeTokens: 9000 } }
  return { before, after }
}

test('accepts native occupancy below the budget without replacing model capacity or lifetime accounting', () => {
  const { before, after } = observations()
  assert.doesNotThrow(() => assertCodexContextBudget(before, after, 500000))
})

test('rejects a preference acknowledgement with an unchanged or unavailable native window', () => {
  const { before, after } = observations()
  assert.throws(() => assertCodexContextBudget(before, { ...after, context: before.context }, 500000))
  assert.throws(() => assertCodexContextBudget(before, { ...after, context: null }, 500000))
  assert.throws(() => assertCodexContextBudget({ ...before, context: null }, after, 500000))
})

test('rejects stale, estimated, foreign-session and conflated-model observations', () => {
  const { before, after } = observations()
  for (const change of [{ stale: true }, { accuracy: 'estimated' }, { nativeSessionId: 'foreign' }]) {
    assert.throws(() => assertCodexContextBudget(before,
      { ...after, context: { ...after.context, ...change } }, 500000))
  }
  assert.throws(() => assertCodexContextBudget(before,
    { ...after, capabilities: { modelCapacity: 500000 } }, 500000))
})
