import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkerConversationBindingSchema, WorkerConversationRpcRequestSchema } from './workerConversations.js'

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
