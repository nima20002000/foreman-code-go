import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import {
  WorkActivationInputSchema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { workResultRepairPrompt } from '../interactions/workResultRepair.js'
import { currentInitialPrompt } from './currentRouting.js'
import { normalizeRepeatTerminal } from './repeatNode.js'

function fixture() {
  const saved = makeCurrentWorkflowFixture('received-work-return')
  const version = WorkflowVersionV3Schema.parse({ ...saved.version,
    definition: { ...saved.version.definition, handoffs: { contractVersion: 1 } } })
  const [requester, receiver] = saved.version.definition.nodes
  const requestId = `work-request-${'abcd1234'.repeat(8)}`
  const activationId = 'received-work-activation'
  const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: {},
    occurrence: null, entry: null, predecessors: [], work: {
      kind: 'work_request', activation: { scope: saved.scope, activationId,
        workflowNodeId: receiver!.id, lineageId: saved.run.id, cause: { kind: 'work_request', requestId } },
      request: { scope: saved.scope, requestId, relationshipId: saved.version.definition.edges[0]!.id,
        requesterActivationId: 'requester-activation', requesterExecutionId: 'requester-execution',
        destinationActivationId: activationId, requesterNodeId: requester!.id, destinationNodeId: receiver!.id,
        payloadDigest: `sha256:${'1'.repeat(64)}`, acceptedAt: saved.createdAt, ordinal: 1 },
      acceptedSourceResult: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
        data: { latestDeliverable: 'Check the deliverable.', remainingFindings: [] } } },
    } })
  const { executionId, ...identity } = saved.identities[1]!
  const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId, runId: saved.run.id,
    input, state: 'completed', createdAt: saved.createdAt, finishedAt: saved.createdAt,
    result: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
      data: { latestDeliverable: 'Done', remainingFindings: [] } } } })
  const answer = (id: string, outcome: 'accepted' | 'needs_changes'): ExecutionResult => ({
    outcome: 'succeeded', output: { text: JSON.stringify({ routing: { kind: 'return', requestId: id, outcome },
      data: { latestDeliverable: { summary: 'Checked' }, remainingFindings: [] } }) },
  })
  return { ...saved, version, execution, input, requestId, answer,
    ref: { nodeId: receiver!.id, occurrence: null }, contract: currentInitialPrompt({}, false, true)! }
}

describe('received work return identity', () => {
  it.each(['accepted', 'needs_changes'] as const)('repairs a mistyped %s request ID before terminal publication', outcome => {
    const f = fixture()
    const wrong = f.answer(f.requestId.slice(0, -6), outcome)
    const before = structuredClone(wrong)
    const prompt = workResultRepairPrompt(wrong, f.contract, f.input)
    expect(prompt).toContain('Validation issues:')
    expect(prompt).toContain(f.requestId)
    expect(prompt).toContain(f.contract)
    expect(wrong).toEqual(before)
  })

  it.each(['accepted', 'needs_changes'] as const)('fails an uncorrected %s return instead of storing success', outcome => {
    const f = fixture()
    const result = f.answer(f.requestId.slice(0, -6), outcome)
    const normalized = normalizeRepeatTerminal(f.version, f.scope, f.ref, { ...f.execution, result })
    expect(normalized.result).toMatchObject({ outcome: 'failed',
      error: { code: 'WORK_RESULT_INVALID', retryable: false } })
    expect(result.outcome).toBe('succeeded')
  })

  it.each(['accepted', 'needs_changes'] as const)('preserves a valid %s return and its original text', outcome => {
    const f = fixture()
    const result = f.answer(f.requestId, outcome)
    const execution = { ...f.execution, result }
    expect(workResultRepairPrompt(result, f.contract, f.input)).toBeUndefined()
    expect(normalizeRepeatTerminal(f.version, f.scope, f.ref, execution)).toEqual(execution)
  })

  it('allows the receiver to finish along its saved downstream routes', () => {
    const f = fixture()
    const result: ExecutionResult = { outcome: 'succeeded', output: { routing: { kind: 'finish' },
      data: { latestDeliverable: 'Done', remainingFindings: [] } } }
    expect(workResultRepairPrompt(result, f.contract, f.input)).toBeUndefined()
    const execution = { ...f.execution, result }
    expect(normalizeRepeatTerminal(f.version, f.scope, f.ref, execution)).toEqual(execution)
  })
})
