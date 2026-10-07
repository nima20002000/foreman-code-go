import assert from 'node:assert/strict'

export function assertCodexContextBudget(before, after, budget) {
  assert.ok(before.nativeSessionId)
  assert.equal(after.nativeSessionId, before.nativeSessionId)
  assert.equal(after.applied.contextBudget, budget)
  assert.equal(after.capabilities.modelCapacity, before.capabilities.modelCapacity)
  assert.ok(before.context?.capacityTokens > 0, 'Observe the native default window before changing its budget.')
  assert.equal(after.context?.nativeSessionId, before.nativeSessionId)
  assert.equal(after.context?.source, 'codex')
  assert.equal(after.context?.accuracy, 'native')
  assert.equal(after.context?.stale, false, 'An old usage observation cannot qualify the new budget.')
  assert.ok(after.context.capacityTokens > 0 && after.context.capacityTokens <= budget,
    'The native window did not respect the configured budget.')
  if (budget < before.context.capacityTokens) {
    assert.ok(after.context.capacityTokens < before.context.capacityTokens,
      'The preference acknowledgement did not change the native window.')
  }
}
