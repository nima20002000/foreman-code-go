import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { makeWave25Fixture } from '@graphql/contracts/wave25'
import { bindOneShotInput, normalizeOneShotTerminal, oneShotResolution } from '../src/modules/runs/oneShotResolution.js'

function choiceFixture() {
  const fixture = makeWave25Fixture('a3-choice')
  fixture.version.definition.nodes[0]!.choice = { outcomes: [
    { outcome: 'pass', target: { kind: 'branch_end' } },
    { outcome: 'issues', target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } },
  ] }
  return fixture
}

describe('Agent 3 complete accepted evidence and exact input receipts', () => {
  it.each(['pass', 'issues'])('selects the finite %s route from a complete envelope', (outcome) => {
    const f = choiceFixture()
    const execution = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output: { routing: { outcome }, data: { ok: true } } } })
    const resolved = oneShotResolution(f.version, normalizeOneShotTerminal(f.version, execution))
    expect(resolved.selectedRelationshipIds).toEqual(outcome === 'issues' ? [f.version.definition.edges[0]!.id] : [])
    expect(resolved.branchEnded).toBe(outcome === 'pass')
  })
  it.each([
    '```json\n{"routing":{"outcome":"pass"},"data":{}}\n```',
    'prefix {"routing":{"outcome":"pass"},"data":{}}',
    '{"routing":{"outcome":"pass"},"data":{}} trailing',
    { routing: { outcome: 'unknown' }, data: {} },
    { routing: { outcome: 'pass', targetNodeId: 'fixer' }, data: {} },
    { routing: { outcome: 'pass' } },
    { data: {} },
    { routing: { outcome: 'issues' }, data: {}, extra: true },
    { routing: { outcome: 'issues' }, data: 'x'.repeat(70 * 1024) },
  ])('fails malformed or oversized routing evidence without a fallback', (output) => {
    const f = choiceFixture()
    const execution = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output } })
    const normalized = normalizeOneShotTerminal(f.version, execution)
    expect(normalized.result?.outcome).toBe('failed')
    const resolved = oneShotResolution(f.version, normalized)
    expect(resolved.selectedRelationshipIds).toEqual([])
    expect(resolved.unselectedRelationshipIds).toEqual([f.version.definition.edges[0]!.id])
  })
  it('binds exact accepted predecessor identity, result digest, input ordinal, and stable receipt ID', () => {
    const f = choiceFixture()
    const previous = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output: { routing: { outcome: 'issues' }, data: { finding: 7 } } } })
    const resolution = oneShotResolution(f.version, previous)
    const request = { version: f.version, runInput: f.run.input, recipient: f.executions[1]!, boundAt: f.createdAt,
      resolutions: new Map([[previous.workflowNodeId, resolution]]), predecessors: new Map([[previous.id, { execution: previous, accepted: true }]]) }
    const first = bindOneShotInput(request)
    const repeat = bindOneShotInput(request)
    expect(repeat).toEqual(first)
    expect(first.bindings[0]).toMatchObject({ inputOrdinal: 0, sender: { executionId: previous.id }, recipient: { executionId: f.executions[1]!.id } })
    expect(first.execution.input).toMatchObject({ predecessors: [{ acceptedResult: previous.result, senderExecutionId: previous.id }] })
    expect(() => bindOneShotInput({ ...request, predecessors: new Map([[previous.id, { execution: previous, accepted: false }]]) })).toThrow()
    const changed = HarnessExecutionSchema.parse({ ...previous, result: { outcome: 'succeeded', output: 'different' } })
    expect(() => bindOneShotInput({ ...request, predecessors: new Map([[previous.id, { execution: changed, accepted: true }]]) })).toThrow()
  })
})
