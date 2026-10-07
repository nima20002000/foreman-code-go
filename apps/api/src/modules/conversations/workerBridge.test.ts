import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { WorkerOpenCodeFilePreparationSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { fileToolFixture } from '../../../test/support/fileTools.js'
import { nativeMessageId } from '../harnesses/opencodeProtocol.js'

function setup() {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const current = vi.fn(async () => {})
  const send = vi.fn(async (payload: unknown) => ({ payload: { received: payload } }))
  const request: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding: f.binding,
    session: f.session, prompt: 'Admitted task', correlationId: 'original-correlation', sessionMode: 'plan' }
  const submitted = vi.fn(async () => {})
  const applied = vi.fn(async () => {})
  const lease = bridge.capture({ request, current, channel: { binding: f.connection, request: send },
    callbacks: { submitted, settingsApplied: applied } })
  const invoke = (payload: Record<string, unknown>) => bridge.handle({ ...payload,
    binding: f.binding, admissionId: lease.admissionId }, f.connection, AbortSignal.timeout(1000))
  return { ...f, bridge, current, send, request, submitted, applied, lease, invoke }
}

it('journals a terminal callback only after its native message was acknowledged on the same admission', async () => {
  const f = workerConversationFixture('operator', 'claude')
  const bridge = new MainWorkerConversationBridge()
  const current = vi.fn(async () => {})
  const terminal = vi.fn(async () => {})
  const correlationId = 'accepted-message'
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'native-input', clientCorrelationId: correlationId }
  const lease = bridge.capture({ request: { method: 'conversation.start-turn', binding: f.binding,
    session: f.session, prompt: 'Accepted input', correlationId }, current,
    channel: { binding: f.connection, request: async () => ({ payload: {} }) },
    callbacks: { submitted: async () => {}, terminalObserved: terminal } })
  const observation = { submission, result: { outcome: 'succeeded' as const },
    history: { events: [], pendingInteractions: [], correlationId, nativeSubmission: submission } }
  const invoke = (payload: Record<string, unknown>) => bridge.handle({ ...payload, binding: f.binding,
    admissionId: lease.admissionId }, f.connection, AbortSignal.timeout(1000))
  try {
    await expect(invoke({ method: 'conversation.terminal-observed', observation }))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CALLBACK_DENIED' })
    expect(terminal).not.toHaveBeenCalled()
    await invoke({ method: 'conversation.submitted', correlationId, identity: { nativeSubmission: submission } })
    await expect(invoke({ method: 'conversation.terminal-observed', observation: { ...observation,
      submission: { ...submission, nativeMessageId: 'foreign-input' } } }))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CALLBACK_DENIED' })
    await invoke({ method: 'conversation.terminal-observed', observation })
    expect(terminal).toHaveBeenCalledExactlyOnceWith(observation)
    current.mockRejectedValueOnce(new Error('Sender revoked'))
    await expect(invoke({ method: 'conversation.terminal-observed', observation })).rejects.toThrow('Sender revoked')
    expect(terminal).toHaveBeenCalledTimes(1)
  } finally { await lease.close(); await bridge.close() }
})

it('binds OpenCode file callbacks to their admitted chat and persisted acknowledgement on the paired channel', async () => {
  const f = workerConversationFixture('agent', 'opencode')
  const files = await fileToolFixture()
  const ref = await files.upload()
  const correlationId = `agent-chat:${files.scope.chat.conversationId}:${randomUUID()}`
  const turnId = nativeMessageId(correlationId)
  const context = { ...files.context, turnId, messageId: 'accepted-message' }
  const binding = { ...f.binding, owner: { ...f.binding.owner, conversationId: files.scope.chat.conversationId,
    kind: 'agent' as const, agentId: 'agent-a', workspaceId: 'workspace-a', workflowId: 'workflow-a', workflowNodeId: 'node' } }
  const session = { ...f.session, nativeSessionId: context.nativeSessionId }
  if (f.configuration.harness.harness !== 'opencode') throw new Error('OpenCode fixture required')
  const identity = { ownerAgentId: 'agent-a', nativeSessionId: session.nativeSessionId, nativeTurnId: turnId,
    clientCorrelationId: correlationId, directory: binding.workingDirectory,
    configuration: f.configuration.harness }
  const current = vi.fn(async () => {})
  const submitted = vi.fn(async () => {})
  const bridge = new MainWorkerConversationBridge()
  const openCodeFiles = { service: () => files.service,
    sourceHost: () => ({ bootId: f.connection.bootId, storageRoot: '/main-private-vault' }),
    resolve: async () => ({ context, attachments: [ref] }), adopt: async () => {} }
  const lease = bridge.capture({ request: { method: 'conversation.start-turn', binding, session,
    prompt: 'Accepted input', correlationId, sessionMode: 'plan' }, current,
  channel: { binding: f.connection, request: async () => ({ payload: {} }) }, callbacks: {
    submitted, openCodeFiles,
  } })
  const invoke = (action: unknown, actual = identity, connection = f.connection) => bridge.handle({
    method: 'conversation.opencode-files', binding, admissionId: lease.admissionId, identity: actual, action,
  }, connection, AbortSignal.timeout(5000))
  try {
    const prepared = WorkerOpenCodeFilePreparationSchema.parse(await invoke({ phase: 'prepare' }))
    expect(prepared.context.allowMutation).toBe(false)
    const issue = { phase: 'issue', context: prepared.context, expiresAt: prepared.expiresAt }
    await expect(invoke(issue)).rejects.toMatchObject({ status: 403 })
    await bridge.handle({ method: 'conversation.submitted', binding, admissionId: lease.admissionId,
      correlationId, identity: { nativeTurnId: turnId } }, f.connection, AbortSignal.timeout(5000))
    expect(submitted).toHaveBeenCalledOnce()
    const original = await invoke(issue) as { token: string }
    await expect(invoke({ phase: 'prepare' }, { ...identity, nativeSessionId: 'foreign' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(invoke({ phase: 'prepare' }, identity, { ...f.connection, connectionGeneration: 2 }))
      .rejects.toMatchObject({ status: 403 })
    current.mockRejectedValueOnce(new Error('Sender revoked'))
    await expect(invoke({ phase: 'read-input', input: { ...ref, offset: 0, length: 1 } })).rejects.toThrow('Sender revoked')
    await lease.close()
    const recovered = bridge.capture({ request: { method: 'conversation.reconcile', binding, session,
      correlationId, sessionMode: 'plan' }, current, recoveredTurnId: turnId,
    channel: { binding: f.connection, request: async () => ({ payload: {} }) }, callbacks: { openCodeFiles } })
    const recover = (action: unknown) => bridge.handle({ method: 'conversation.opencode-files', binding,
      admissionId: recovered.admissionId, identity, action }, f.connection, AbortSignal.timeout(5000))
    await expect(recover(issue)).rejects.toMatchObject({ status: 403 })
    await expect(recover({ phase: 'recover', context: { ...prepared.context, allowMutation: true } }))
      .rejects.toMatchObject({ status: 403 })
    await recover({ phase: 'recover', context: prepared.context })
    const replacement = await recover(issue) as { token: string }
    expect(replacement.token).not.toBe(original.token)
    await expect(files.sessions.authenticate(original.token)).rejects.toMatchObject({ status: 401 })
    expect((await files.sessions.authenticate(replacement.token)).context.allowMutation).toBe(false)
    await recovered.close()
  } finally {
    await lease.close()
    await bridge.close()
  }
})

it('authorizes only the Main-issued request and rechecks its live grants', async () => {
  const f = setup()
  await f.lease.request()
  const frame = f.send.mock.calls[0]![0]
  expect(await f.invoke({ method: 'conversation.authorize', request: frame })).toEqual({ authorized: true })
  expect(f.current.mock.calls.length).toBeGreaterThanOrEqual(3)
  await expect(f.invoke({ method: 'conversation.authorize', request: { ...f.request,
    admissionId: f.lease.admissionId, prompt: 'Replacement task' } })).rejects.toMatchObject({ status: 403 })
  f.current.mockRejectedValueOnce(new Error('Principal revoked'))
  await expect(f.invoke({ method: 'conversation.authorize', request: frame })).rejects.toThrow('Principal revoked')
  await f.lease.close()
})

it('allows a scoped access change only through its issued attachment or credential-delivery admission', async () => {
  const f = workerConversationFixture()
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const current = vi.fn(async () => {})
  const bridge = new MainWorkerConversationBridge()
  const channel = { binding: f.connection, request: async () => ({ payload: {} }) }
  const open: WorkerConversationRpcRequest = { method: 'conversation.open', binding: next,
    previousBinding: f.binding, mode: 'attach', source: f.session,
    operationId: 'admitted-message', configuration: f.configuration }
  const lease = bridge.capture({ request: open, current, channel })
  const authorize = () => bridge.authorizeAppAccessChange(lease.admissionId, f.binding, next,
    f.connection, AbortSignal.timeout(1000))
  await expect(authorize()).resolves.toBeUndefined()
  current.mockRejectedValueOnce(new Error('Sender revoked'))
  await expect(authorize()).rejects.toThrow('Sender revoked')
  await lease.close()
  await expect(authorize()).rejects.toMatchObject({ status: 403 })
  const inspection = bridge.capture({ request: { method: 'conversation.capabilities', binding: next,
    configuration: f.configuration }, current, channel })
  await expect(bridge.authorizeAppAccessChange(inspection.admissionId, f.binding, next,
    f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  await inspection.close()
})

it('uses the current callback signal after an earlier request signal has ended', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const before = new AbortController()
  const current = vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted() })
  const send = vi.fn(async (payload: unknown) => ({ payload }))
  const lease = bridge.capture({ request: { method: 'conversation.status', binding: f.binding }, current,
    channel: { binding: f.connection, request: send } })
  await lease.request(before.signal)
  before.abort(new Error('Earlier HTTP request ended'))
  const callback = { method: 'conversation.authorize', binding: f.binding, admissionId: lease.admissionId,
    request: send.mock.calls[0]![0] }
  await expect(bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).resolves.toEqual({ authorized: true })
  const stopped = new AbortController()
  stopped.abort(new Error('Current callback ended'))
  await expect(bridge.handle(callback, f.connection, stopped.signal)).rejects.toThrow('Current callback ended')
  await lease.close()
})

it('requires a persisted Claude message acknowledgement before authorizing native callbacks', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const binding = { ...f.binding, harness: 'claude' as const }
  const session = { ...f.session, harness: 'claude' as const, providerVersion: '2.1.284' }
  const request: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding, session,
    prompt: 'Recorded input', correlationId: 'message-correlation' }
  const current = vi.fn(async () => {})
  const authority = vi.fn(async () => ({ authorized: true }))
  const lease = bridge.capture({ request, current, channel: { binding: f.connection, request: async () => ({ payload: {} }) },
    callbacks: { claudeAuthority: authority, submitted: async () => {} } })
  const invoke = (payload: Record<string, unknown>) => bridge.handle({ ...payload,
    binding, admissionId: lease.admissionId }, f.connection, AbortSignal.timeout(1000))
  const identity = { ownerPrincipalId: 'sender', attemptId: 'request', nativeSessionId: session.nativeSessionId,
    nativeMessageId: 'native-message', clientCorrelationId: 'message-correlation', generation: 'sdk-generation', toolUseId: 'tool' }
  const validate = { method: 'conversation.claude-authority', request: { phase: 'validate', identity } }
  await expect(invoke(validate)).rejects.toMatchObject({ status: 403 })
  expect(authority).not.toHaveBeenCalled()
  await invoke({ method: 'conversation.submitted', correlationId: 'message-correlation', identity: {
    nativeSubmission: { kind: 'message', nativeSessionId: session.nativeSessionId,
      nativeMessageId: 'native-message', clientCorrelationId: 'message-correlation' } } })
  await expect(invoke(validate)).resolves.toEqual({ authorized: true })
  await expect(invoke({ ...validate, request: { phase: 'validate', identity: { ...identity, nativeMessageId: 'another-message' } } }))
    .rejects.toMatchObject({ status: 403 })
  await expect(invoke({ ...validate, request: { phase: 'validate', identity: { ...identity, generation: 'another-query' } } }))
    .rejects.toMatchObject({ status: 403 })
  current.mockRejectedValueOnce(new Error('Original sender revoked'))
  await expect(invoke(validate)).rejects.toThrow('Original sender revoked')
  await lease.close()
  await expect(invoke(validate)).rejects.toMatchObject({ status: 403 })
})

it('never lets a read-only conversation lease supply new Claude message authority', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const binding = { ...f.binding, harness: 'claude' as const }
  const request: WorkerConversationRpcRequest = { method: 'conversation.status', binding }
  const authority = vi.fn(async () => ({ ownerPrincipalId: 'sender', attemptId: 'request' }))
  const lease = bridge.capture({ request, current: async () => {},
    channel: { binding: f.connection, request: async () => ({ payload: {} }) }, callbacks: { claudeAuthority: authority } })
  await expect(bridge.handle({ method: 'conversation.claude-authority', binding, admissionId: lease.admissionId,
    request: { phase: 'admission' } }, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  expect(authority).not.toHaveBeenCalled()
  await lease.close()
})

it('keeps recovered Claude callbacks on the submitted message and current sender grants', async () => {
  const f = workerConversationFixture('agent', 'claude')
  const bridge = new MainWorkerConversationBridge()
  const correlationId = 'existing-message'
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'submitted-native-message', clientCorrelationId: correlationId }
  const request: WorkerConversationRpcRequest = { method: 'conversation.reconcile', binding: f.binding,
    session: f.session, correlationId }
  const current = vi.fn(async () => {})
  const authority = vi.fn(async () => ({ authorized: true }))
  const channel = { binding: f.connection, request: async () => ({ payload: {} }) }
  const lease = bridge.capture({ request, current, channel, recoveredSubmission: submission,
    callbacks: { claudeAuthority: authority } })
  const identity = { ownerPrincipalId: 'original-sender', attemptId: 'original-request',
    nativeSessionId: f.session.nativeSessionId, nativeMessageId: submission.nativeMessageId,
    clientCorrelationId: correlationId, generation: 'original-query', toolUseId: 'original-tool' }
  const invoke = (value: typeof identity) => bridge.handle({ method: 'conversation.claude-authority', binding: f.binding,
    admissionId: lease.admissionId, request: { phase: 'validate', identity: value } }, f.connection, AbortSignal.timeout(1000))
  expect(await invoke(identity)).toEqual({ authorized: true })
  await expect(invoke({ ...identity, nativeMessageId: 'different-message' })).rejects.toMatchObject({ status: 403 })
  await expect(invoke({ ...identity, generation: 'different-query' })).rejects.toMatchObject({ status: 403 })
  current.mockRejectedValueOnce(new Error('Sender revoked'))
  await expect(invoke(identity)).rejects.toThrow('Sender revoked')
  expect(authority).toHaveBeenCalledOnce()
  await lease.close()
  await expect(invoke(identity)).rejects.toMatchObject({ status: 403 })
  expect(() => bridge.capture({ request, current, channel,
    recoveredSubmission: { ...submission, nativeSessionId: 'another-session' } })).toThrow()
  const reader = bridge.capture({ request, current, channel, callbacks: { claudeAuthority: authority } })
  await expect(bridge.handle({ method: 'conversation.claude-authority', binding: f.binding,
    admissionId: reader.admissionId, request: { phase: 'admission' } }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  await reader.close()
})

it('rejects unissued admissions, foreign conversations and other authenticated generations', async () => {
  const f = setup()
  const callback = { method: 'conversation.submitted', admissionId: f.lease.admissionId,
    binding: f.binding, correlationId: 'original-correlation', identity: { nativeTurnId: 'observed-turn' } }
  await expect(f.bridge.handle({ ...callback, admissionId: randomUUID() }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  await expect(f.bridge.handle({ ...callback, binding: { ...f.binding,
    owner: { ...f.binding.owner, conversationId: randomUUID() } } }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  await expect(f.bridge.handle(callback, { ...f.connection, connectionEpoch: randomUUID() }, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  expect(f.submitted).not.toHaveBeenCalled()
  await f.lease.close()
})

it('preserves provider identity and refuses a different message, turn or correlation', async () => {
  const f = setup()
  const submission = { method: 'conversation.submitted', correlationId: 'original-correlation',
    identity: { nativeTurnId: 'observed-turn' } }
  expect(await f.invoke(submission)).toEqual({ acknowledged: true })
  expect(f.submitted).toHaveBeenCalledWith('original-correlation', { nativeTurnId: 'observed-turn' })
  await expect(f.invoke({ ...submission, correlationId: 'another-correlation' })).rejects.toMatchObject({ status: 403 })
  await expect(f.invoke({ ...submission, identity: { nativeTurnId: 'different-turn' } })).rejects.toMatchObject({ status: 403 })
  await expect(f.invoke({ ...submission, identity: { nativeSubmission: { kind: 'message',
    clientCorrelationId: 'original-correlation', nativeSessionId: 'foreign-session', nativeMessageId: 'observed-message' } } }))
    .rejects.toMatchObject({ status: 403 })
  expect(f.submitted).toHaveBeenCalledOnce()
  await f.lease.close()
})

it('does not acknowledge failed persistence and rejects callbacks after Main detaches', async () => {
  const f = setup()
  const callback = { method: 'conversation.submitted', correlationId: 'original-correlation', identity: { nativeTurnId: 'observed-turn' } }
  f.submitted.mockRejectedValueOnce(new Error('Persistence failed'))
  await expect(f.invoke(callback)).rejects.toThrow('Persistence failed')
  expect(await f.invoke(callback)).toEqual({ acknowledged: true })
  await f.lease.close()
  await expect(f.invoke(callback)).rejects.toMatchObject({ status: 403 })
  expect(f.submitted).toHaveBeenCalledTimes(2)
})

it('keeps read admissions unable to claim execution or applied settings', async () => {
  const f = setup()
  const observed = vi.fn(async () => {})
  const applied = vi.fn(async () => {})
  const reader = f.bridge.capture({ request: { method: 'conversation.status', binding: f.binding }, current: f.current,
    channel: { binding: f.connection, request: f.send }, callbacks: { sessionObserved: observed, settingsApplied: applied } })
  await expect(f.bridge.handle({ method: 'conversation.session-observed', binding: f.binding,
    admissionId: reader.admissionId, session: f.session }, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  await expect(f.bridge.handle({ method: 'conversation.settings-applied', binding: f.binding,
    admissionId: reader.admissionId, correlationId: 'original-correlation' }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  expect(observed).not.toHaveBeenCalled()
  expect(applied).not.toHaveBeenCalled()
  await reader.close()
  await f.lease.close()
})

it('forwards the native applied-settings acknowledgement only for the admitted turn', async () => {
  const f = setup()
  expect(await f.invoke({ method: 'conversation.settings-applied', correlationId: 'original-correlation' }))
    .toEqual({ acknowledged: true })
  expect(f.applied).toHaveBeenCalledOnce()
  await f.bridge.close()
  await expect(f.lease.request()).rejects.toMatchObject({ status: 403 })
})

it('keeps native profile reads on a live Main-issued request and rechecks the caller', async () => {
  const f = setup()
  const profile = vi.fn(async () => { throw new Error('Profile unavailable') })
  const reader = f.bridge.capture({ request: { method: 'conversation.capabilities', binding: f.binding,
    configuration: f.configuration }, current: f.current, channel: { binding: f.connection, request: f.send },
    callbacks: { profile } })
  const callback = { method: 'conversation.profile', binding: f.binding, admissionId: reader.admissionId }
  await expect(f.bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).rejects.toThrow('Profile unavailable')
  expect(profile).toHaveBeenCalledOnce()
  f.current.mockRejectedValueOnce(new Error('Read grant revoked'))
  await expect(f.bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).rejects.toThrow('Read grant revoked')
  expect(profile).toHaveBeenCalledOnce()
  await reader.close()
  await expect(f.bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  await f.lease.close()
})
