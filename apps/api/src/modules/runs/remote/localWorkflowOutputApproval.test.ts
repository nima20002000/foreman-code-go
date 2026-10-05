import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  DurableInteractionSchema, HarnessExecutionSchema, OPENCODE_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'
import { nativeOutputToolArguments, WorkerNativeOutputCommandSchema } from '@foreman-code/contracts/worker-native-output'
import type { FileQuery } from '../../files/repository.js'
import type { NativeOutputCallCapture } from '../../harnesses/port.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import { assertOpenCodeNativeOutputCall } from './localWorkflowOutputApproval.js'

function fixture() {
  const now = '2026-10-05T00:00:00.000Z'
  const configuration = AgentConfigurationVersionSchema.parse({ id: 'configuration', agentId: 'agent',
    workspaceId: 'workspace', version: 1, prompt: { system: 'Produce the report.' }, assignedSkills: [],
    harness: { ...DEFAULT_HARNESS_DEFAULTS.opencode, nativeAgent: 'build', advanced: {
      ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
      permissionRules: [{ permission: 'graphql_files_native_output_create', pattern: '*', effect: 'ask' }],
    } }, contentHash: 'configuration-hash', createdAt: now })
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: 'run', workflowNodeId: 'node',
    agentId: 'agent', agentConfigurationVersionId: configuration.id, attempt: 1, input: { task: 'report' },
    state: 'running', nativeSessionId: 'native-session', createdAt: now, startedAt: now })
  const command = WorkerNativeOutputCommandSchema.parse({ operation: 'create', commandId: 'original-create-command',
    filename: 'report.md', mediaType: 'text/markdown' })
  const capture: NativeOutputCallCapture = { descriptor: { nativeSessionId: 'native-session', rootTurnId: 'root-turn',
    assistantMessageId: 'assistant', callId: 'native-call', toolName: 'files.native_output_create',
    nativeToolName: 'graphql_files_native_output_create',
    inputDigest: repeatDigest(nativeOutputToolArguments(command), 4 * 1024 * 1024) }, effectivePolicy: 'ask',
    assertCurrent: vi.fn() }
  const request = { id: 'native-request', sessionID: 'native-session', permission: 'graphql_files_native_output_create',
    patterns: ['*'], always: ['*'], metadata: {}, tool: { messageID: 'assistant', callID: 'native-call' } }
  const option = OPENCODE_APPROVAL_OPTIONS_FIXTURE.find(option => option.semantic === 'approve_once')!
  const session = { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'native-session' }
  const interaction = DurableInteractionSchema.parse({ id: 'interaction', revision: 3, workspaceId: 'workspace',
    workflowId: 'workflow', runId: 'run', executionId: execution.id, requestingAgentId: execution.agentId,
    ...session, nativeRequestId: request.id, nativeRequestType: 'permission.asked', graphThreadId: 'run',
    graphInterruptId: 'interrupt', request, approval: { handler: 'user' }, responseOptions: OPENCODE_APPROVAL_OPTIONS_FIXTURE,
    status: 'delivered', selectedOptionId: option.optionId, selectedSemantic: option.semantic,
    nativeResponse: { optionId: option.optionId, semantic: option.semantic }, deliveryState: 'delivered',
    auditReference: 'user', createdAt: now, decidedAt: now, deliveredAt: now, updatedAt: now })
  const proof: WorkflowNativeProofRecord = { proofId: 'pending-proof', scope: { workspaceId: 'workspace',
    workflowId: 'workflow', workflowVersionId: 'version', runId: 'run', executionSemanticsVersion: 3 },
    ref: { nodeId: 'node', occurrence: null }, execution: repeatExecutionIdentity(execution),
    inputDigest: repeatDigest(execution.input), commandId: 'execution:execution', session,
    original: { type: 'history', history: { events: [], pendingInteractions: [{ session,
      turn: { nativeTurnId: 'root-turn', nativeRequestId: request.id }, nativeRequestType: 'permission.asked',
      request, responseOptions: OPENCODE_APPROVAL_OPTIONS_FIXTURE }] } }, observedAt: now,
    ownerId: 'owner', ownerFence: '1', lifetimeGeneration: 1, closureGeneration: '1',
    lane: { id: 'lane', token: 'native-writer', connectionGeneration: 1, providerId: 'root-turn' } }
  const approval = { interaction, proof, source_digest: repeatDigest(proof, 4 * 1024 * 1024),
    evidence: { source: 'provider_acknowledgement', ...session, nativeRequestId: request.id,
      nativeRequestType: 'permission.asked', optionId: option.optionId, semantic: option.semantic } }
  let approvals = [approval]
  const sql = { query: vi.fn(async (_query: string) => ({ rows: _query.startsWith('select e.record')
    ? [{ execution, configuration, workspace_id: 'workspace', workflow_id: 'workflow', workflow_version_id: 'version' }]
    : approvals })) } as unknown as FileQuery
  const check = () => assertOpenCodeNativeOutputCall(sql, capture, { executionId: execution.id, command })
  return { check, capture, configuration, approval, proof, command, clearApprovals: () => { approvals = [] } }
}

describe('original OpenCode output approval', () => {
  it('permits the captured call after the matching native response is delivered', async () => {
    const f = fixture()
    await expect(f.check()).resolves.toBeUndefined()
    f.clearApprovals()
    await expect(f.check()).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_APPROVAL_PENDING' })
  })
  it.each(['call', 'root', 'scope', 'source', 'delivery'] as const)(
    'does not authorize another %s through an earlier approval', async changed => {
      const f = fixture()
      if (changed === 'call') f.capture.descriptor.callId = 'foreign-call'
      if (changed === 'root') f.capture.descriptor.rootTurnId = 'foreign-root'
      if (changed === 'scope') f.proof.scope.workflowId = 'foreign-workflow'
      if (changed === 'source') f.approval.source_digest = repeatDigest('foreign-source')
      if (changed === 'delivery') f.approval.evidence.nativeRequestId = 'foreign-request'
      await expect(f.check()).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_APPROVAL_PENDING' })
    })
  it('rejects a different command and read-only configuration even when native policy reports allow', async () => {
    const f = fixture()
    f.capture.descriptor.inputDigest = repeatDigest('another-command')
    await expect(f.check()).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_PERMISSION_DENIED' })
    f.capture.descriptor.inputDigest = repeatDigest(nativeOutputToolArguments(f.command), 4 * 1024 * 1024)
    if (f.configuration.harness.harness !== 'opencode') throw new Error('OpenCode fixture required')
    f.configuration.harness.nativeAgent = 'plan'
    f.capture.effectivePolicy = 'allow'
    await expect(f.check()).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_PERMISSION_DENIED' })
  })
  it('honors an explicitly delivered provider allowance for later matching calls in the same turn', async () => {
    const f = fixture()
    const option = OPENCODE_APPROVAL_OPTIONS_FIXTURE.find(option => option.semantic === 'provider_scoped_allow')!
    f.approval.interaction.selectedOptionId = option.optionId
    f.approval.interaction.selectedSemantic = option.semantic
    f.approval.interaction.nativeResponse = { optionId: option.optionId, semantic: option.semantic }
    f.approval.evidence.optionId = option.optionId
    f.approval.evidence.semantic = option.semantic
    f.capture.descriptor.callId = 'later-native-call'
    await expect(f.check()).resolves.toBeUndefined()
  })
  it('uses native-auto evidence only for the saved automatic mode and exact native call', async () => {
    const f = fixture()
    f.clearApprovals()
    if (f.configuration.harness.harness !== 'opencode') throw new Error('OpenCode fixture required')
    f.configuration.harness.autoApprove = true
    f.configuration.harness.advanced = { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionHandling: 'native_auto',
      permissionRules: [{ permission: 'graphql_files_native_output_create', pattern: '*', effect: 'ask' }] }
    f.capture.nativeAutoApproval = { nativeRequestId: 'native-request', nativeSessionId: 'native-session',
      permission: 'graphql_files_native_output_create', patterns: ['*'], assistantMessageId: 'assistant',
      callId: 'native-call', reply: 'once' }
    await expect(f.check()).resolves.toBeUndefined()
    f.capture.nativeAutoApproval.callId = 'foreign-call'
    await expect(f.check()).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_APPROVAL_PENDING' })
  })
})
