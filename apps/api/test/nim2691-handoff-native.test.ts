import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { normalizeRepeatTerminal } from '../src/modules/runs/repeatNode.js'
import { repeatNativeObserver } from '../src/modules/runs/repeatRuntime.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'

describe('NIM-2691 native work result boundary', () => {
  it('preserves a complete typed work request and rejects prose without inventing a route', () => {
    const fixture = makeCurrentWorkflowFixture('work-native-result')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      nodes: fixture.version.definition.nodes.map((node, index) => index === 0 ? {
        ...node, choice: { outcomes: [{ outcome: 'review',
          target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] },
      } : node),
    } })
    const node = version.definition.nodes[0]!
    if (node.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    const result = { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
      data: { latestDeliverable: { artifactId: 'a-1' }, remainingFindings: [] } } }
    const execution = HarnessExecutionSchema.parse({ id: 'execution-work-result', runId: fixture.run.id,
      workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, input: {}, state: 'completed', result,
      createdAt: fixture.createdAt, finishedAt: fixture.createdAt })
    const ref = { nodeId: node.id, occurrence: null }
    expect(normalizeRepeatTerminal(version, fixture.scope, ref, execution)).toEqual(execution)
    const malformed = HarnessExecutionSchema.parse({ ...execution, result: { outcome: 'succeeded', output: 'Please send this to C.' } })
    expect(normalizeRepeatTerminal(version, fixture.scope, ref, malformed).result).toMatchObject({
      outcome: 'failed', error: { code: 'WORK_RESULT_INVALID', retryable: false },
    })
  })

  it('does not submit an uncertain recovered activation without an exact native session', async () => {
    const fixture = makeCurrentWorkflowFixture('work-native-unknown')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
    } })
    const run = AcceptedWorkflowRunV3Schema.parse({ ...fixture.run, authorizationPrincipalId: 'principal-unknown',
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/nim2691-unknown-work',
        locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } })
    const node = version.definition.nodes[0]!
    if (node.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    const execution = HarnessExecutionSchema.parse({ id: 'execution-unknown', runId: run.id,
      workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, input: {}, state: 'starting', createdAt: fixture.createdAt,
      startedAt: fixture.createdAt, workingDirectory: run.executionLocation.rootPath,
      runtimeDirectory: '/tmp/nim2691-unknown-runtime' })
    const ref = { nodeId: node.id, occurrence: null }
    let nativeCalls = 0, claims = 0
    const observer = repeatNativeObserver({ run, version,
      owner: { runId: run.id, assertOwned: () => undefined, client: {} } as never,
      store: {
        readExecution: async () => ({ execution, ref, slotId: 'slot-unknown', input: {}, inputDigest: `sha256:${'2'.repeat(64)}`, accepted: false,
          workActivationId: 'activation-unknown' }),
        claimLaunch: async () => { claims++; return undefined },
        recoverSession: async () => execution,
      } as never,
      native: { observeExact: async () => { nativeCalls++; throw new Error('Native must not be reached') },
        assertResume: async () => { throw new Error('No approval is pending') } } as never,
      admission: new RunnerAdmission(1),
      workflows: { getAgentConfiguration: async () => fixture.configurations[0] },
      locations: { revalidateRunAuthorization: async () => undefined,
        revalidateSnapshot: async () => undefined } as never,
      directory: () => execution.runtimeDirectory!,
    })
    await expect(observer(execution, new AbortController().signal))
      .rejects.toMatchObject({ code: 'NATIVE_SESSION_START_UNCERTAIN' })
    expect(claims).toBe(1)
    expect(nativeCalls).toBe(0)
  })
})
