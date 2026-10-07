import assert from 'node:assert/strict'

export function sessionControlHarnesses(input, contracts) {
  const harnesses = contracts.AgentHarnessSchema.array().min(1).max(3)
    .parse(input.harnesses ?? ['codex', 'opencode', 'claude'])
  assert.equal(new Set(harnesses).size, harnesses.length, 'Select each harness once.')
  return harnesses
}
