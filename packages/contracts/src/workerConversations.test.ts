import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkerConversationBindingSchema, WorkerConversationRpcRequestSchema,
  WorkerConversationHistorySchema } from './workerConversations.js'

function binding(kind: 'operator' | 'agent' = 'operator') {
  const common = { conversationId: randomUUID(), configurationVersionId: 'saved-configuration',
    configurationHash: `sha256:${'a'.repeat(64)}` }
  const owner = kind === 'operator' ? { ...common, kind, operatorId: 'application-operator' }
    : { ...common, kind, workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
  return { owner, harness: 'codex', workingDirectory: '/approved/project', appMcpAccess: 'none',
    profile: { instanceId: randomUUID(), instanceRevision: 'profile-revision', target: {
      hostRef: { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() },
      applicationInstallationId: randomUUID(), harnessInstallationId: 'installed-driver', installationFingerprint: 'installation',
    } } }
}

it('retains native input response digests and confirmed non-submission during Worker history readback', () => {
  const history = { events: [], pendingInteractions: [],
    nonSubmission: { nativeSessionId: 'original-session', clientCorrelationId: 'original-message',
      result: { outcome: 'failed', error: { code: 'CODEX_TURN_START_REJECTED',
        message: 'The native message was not accepted.', retryable: true } } },
    responseDeliveries: [{ source: 'provider_history', harness: 'codex', providerVersion: '0.154.0',
      nativeSessionId: 'original-session', nativeRequestId: 'original-form', nativeRequestType: 'mcpServer/elicitation/request',
      optionId: 'offered-choice', semantic: 'approve_once', responseDigest: 'a'.repeat(64) }] }
  expect(WorkerConversationHistorySchema.parse(history)).toEqual(history)
  expect(WorkerConversationHistorySchema.safeParse({ ...history, responseDeliveries: [
    { ...history.responseDeliveries[0], responseDigest: 'not-a-digest' },
  ] }).success).toBe(false)
})

it('addresses an Operator chat without a workflow dispatch or user-grant surrogate', () => {
  const target = binding()
  expect(WorkerConversationRpcRequestSchema.parse({ method: 'conversation.cancel', binding: target,
    session: { harness: 'codex', providerVersion: 'provider-fixture', nativeSessionId: 'observed-session' } }).binding)
    .toEqual(target)
  expect(WorkerConversationBindingSchema.safeParse({ ...target, grants: ['runs:start'] }).success).toBe(false)
  expect(WorkerConversationRpcRequestSchema.safeParse({ method: 'conversation.cancel', binding: target,
    intent: { runId: 'replacement-run' } }).success).toBe(false)
})

it('keeps two nodes with the same Agent independently addressable', () => {
  const first = WorkerConversationBindingSchema.parse(binding('agent'))
  const second = WorkerConversationBindingSchema.parse({ ...first, owner: { ...first.owner,
    conversationId: randomUUID(), workflowNodeId: 'second-node' } })
  expect(first.owner.conversationId).not.toBe(second.owner.conversationId)
  expect(second.profile).toEqual(first.profile)
})

it('keeps approval recovery on its native request and rejects a prompt or grants in that request', () => {
  const request = { method: 'conversation.response-reconcile', binding: binding(),
    session: { harness: 'codex', providerVersion: 'provider-fixture', nativeSessionId: 'observed-session' },
    response: { nativeRequestId: 'approval-request', nativeRequestType: 'command',
      option: { optionId: 'approve-once', label: 'Approve once', semantic: 'approve_once',
        persistence: 'request', affectsOtherPendingRequests: false,
        interruptsCurrentTurn: false, mutatesPersistentPolicy: false } } }
  expect(WorkerConversationRpcRequestSchema.parse(request)).toEqual(request)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, prompt: 'Replay task' }).success).toBe(false)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, grants: ['agent_chat:respond'] }).success).toBe(false)
})

it('rejects Main profiles and management MCP authority on worker Agent chats', () => {
  const target = binding('agent')
  expect(WorkerConversationBindingSchema.safeParse({ ...target, appMcpAccess: 'scoped' }).success).toBe(false)
  const local = { ...target, profile: { ...target.profile, target: { ...target.profile.target,
    hostRef: { kind: 'main', mainId: target.profile.target.hostRef.mainId } } } }
  expect(WorkerConversationBindingSchema.safeParse(local).success).toBe(false)
})

it('requires the native session and original request identity on compact retries', () => {
  const request = { method: 'conversation.compact', binding: binding(), requestId: 'compact-request',
    correlationId: 'compact-correlation', session: {
      harness: 'codex', providerVersion: 'provider-fixture', nativeSessionId: 'observed-session' } }
  expect(WorkerConversationRpcRequestSchema.parse(request)).toEqual(request)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, session: undefined }).success).toBe(false)
  expect(WorkerConversationRpcRequestSchema.safeParse({ ...request, requestId: '' }).success).toBe(false)
})
