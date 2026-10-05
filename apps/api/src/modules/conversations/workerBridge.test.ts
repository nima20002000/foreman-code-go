import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'

function setup() {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const current = vi.fn(async () => {})
  const send = vi.fn(async (_payload: unknown) => ({ payload: { receipt: undefined } }))
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
  f.lease.close()
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
  f.lease.close()
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
  f.lease.close()
})

it('does not acknowledge failed persistence and rejects callbacks after Main detaches', async () => {
  const f = setup()
  const callback = { method: 'conversation.submitted', correlationId: 'original-correlation', identity: { nativeTurnId: 'observed-turn' } }
  f.submitted.mockRejectedValueOnce(new Error('Persistence failed'))
  await expect(f.invoke(callback)).rejects.toThrow('Persistence failed')
  expect(await f.invoke(callback)).toEqual({ acknowledged: true })
  f.lease.close()
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
  reader.close()
  f.lease.close()
})

it('forwards the native applied-settings acknowledgement only for the admitted turn', async () => {
  const f = setup()
  expect(await f.invoke({ method: 'conversation.settings-applied', correlationId: 'original-correlation' }))
    .toEqual({ acknowledged: true })
  expect(f.applied).toHaveBeenCalledOnce()
  f.bridge.close()
  await expect(f.lease.request()).rejects.toMatchObject({ status: 403 })
})
