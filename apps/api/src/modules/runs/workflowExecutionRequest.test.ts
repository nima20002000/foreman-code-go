import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { WorkActivationInputSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'

function fixture() {
  const saved = makeCurrentWorkflowFixture('system-prompt-request', 'single')
  const { executionId, ...identity } = saved.identities[0]!
  const execution = HarnessExecutionSchema.parse({
    ...identity, id: executionId,
    runId: saved.run.id, state: 'starting', createdAt: saved.createdAt,
    workingDirectory: '/work', runtimeDirectory: '/runtime', input: { task: 'accepted input' },
  })
  const configuration = { ...saved.configurations[0]!, instructionDelivery: 'native-v1' as const }
  return { saved, execution, configuration }
}

describe('workflow session prompt snapshot', () => {
  it('carries the saved system prompt into the native request without repeating it in turn input', () => {
    const { saved, execution, configuration } = fixture()
    execution.systemPrompt = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
    const request = workflowExecutionRequest({ execution, version: saved.version, configuration,
      workspaceId: saved.run.workspaceId })
    expect(request.systemPrompt).toEqual(execution.systemPrompt)
    expect(buildHarnessPrompt(request)).toContain('accepted input')
    expect(buildHarnessPrompt(request)).not.toContain('App instructions.')
  })

  it('keeps historical sessions without a system prompt snapshot unchanged', () => {
    const { saved, execution, configuration } = fixture()
    const request = workflowExecutionRequest({ execution, version: saved.version, configuration,
      workspaceId: saved.run.workspaceId })
    expect(request.systemPrompt).toBeUndefined()
  })
})

describe('work-handoff routing guidance', () => {
  function received(downstream: boolean) {
    const saved = makeCurrentWorkflowFixture('handoff-guidance', 'sequential')
    const [requester, checker] = saved.version.definition.nodes
    const fixer = { ...checker!, id: 'node-handoff-guidance-fixer', name: 'Fixer' }
    const definition = { ...saved.version.definition, handoffs: { contractVersion: 1 as const },
      nodes: downstream ? [requester!, checker!, fixer] : [requester!, checker!],
      edges: downstream ? [...saved.version.definition.edges,
        { id: 'edge-handoff-guidance-failures', kind: 'execution' as const, source: checker!.id, target: fixer.id }]
        : saved.version.definition.edges }
    const { executionId, ...identity } = saved.identities[1]!
    const requestId = 'work-request-handoff-guidance'
    const activationId = 'activation-handoff-guidance'
    const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: saved.run.input,
      occurrence: null, entry: null, predecessors: [], work: {
        kind: 'work_request', activation: { scope: saved.scope, activationId, workflowNodeId: checker!.id,
          lineageId: saved.run.id, cause: { kind: 'work_request', requestId } },
        request: { scope: saved.scope, requestId, relationshipId: saved.version.definition.edges[0]!.id,
          requesterActivationId: 'activation-requester', requesterExecutionId: 'execution-requester',
          destinationActivationId: activationId, requesterNodeId: requester!.id, destinationNodeId: checker!.id,
          payloadDigest: `sha256:${'1'.repeat(64)}`, acceptedAt: saved.createdAt, ordinal: 1 },
        acceptedSourceResult: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
          data: { latestDeliverable: 'Run the check.', remainingFindings: [] } } } } })
    const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId, runId: saved.run.id,
      state: 'starting', createdAt: saved.createdAt, workingDirectory: '/work', runtimeDirectory: '/runtime', input })
    return workflowExecutionRequest({ execution, version: { ...saved.version, definition },
      configuration: saved.configurations[1]!, workspaceId: saved.run.workspaceId }).initialPrompt!
  }

  it('tells an Agent with a saved downstream route that finish, not return, reaches the next Agent', () => {
    const prompt = received(true)
    expect(prompt).toContain('To hand your deliverable to the next Agent ("Fixer"), use {"kind":"finish"}')
    expect(prompt).toContain('A return goes back to "Worker 0" only and never starts "Fixer".')
    expect(prompt).toContain('{"kind":"return","requestId":"work-request-handoff-guidance"}')
    expect(prompt).toContain('requestId may be omitted when replying to the single open request you received.')
  })

  it('offers only the correlated return when the Agent has no downstream route', () => {
    const prompt = received(false)
    expect(prompt).not.toContain('To hand your deliverable to the next Agent')
    expect(prompt).toContain('Use routing.kind "return" only to answer "Worker 0"')
  })
})
