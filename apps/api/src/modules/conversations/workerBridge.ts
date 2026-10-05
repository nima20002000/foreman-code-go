import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  WorkerConversationCallbackSchema, WorkerConversationRpcRequestSchema,
  type WorkerConversationRpcRequest, type WorkerConversationBinding,
} from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'

export interface WorkerConversationCallbacks {
  sessionObserved?(session: NativeSessionReference): Promise<void>
  submitted?(correlationId: string, identity: Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'>): Promise<void>
  settingsApplied?(): Promise<void>
}
export interface WorkerConversationChannel {
  binding: Readonly<DeviceSessionBinding>
  request(payload: unknown, options?: { signal?: AbortSignal }): Promise<DeviceApplicationResult>
}
interface Admission {
  request: WorkerConversationRpcRequest
  channel: WorkerConversationChannel
  current(): Promise<void>
  callbacks: WorkerConversationCallbacks
  tail: Promise<unknown>
  session?: NativeSessionReference
  identities: Map<string, Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'>>
  closed: boolean
}
function denied(): never {
  throw new DomainError('WORKER_CONVERSATION_CALLBACK_DENIED', 'The original admitted worker chat request is unavailable.', 403)
}

/** A worker callback needs a live Main-issued request; the nonce supplies no user authority. */
export class MainWorkerConversationBridge {
  private readonly admissions = new Map<string, Admission>()

  capture(input: { request: WorkerConversationRpcRequest; channel: WorkerConversationChannel;
    current(): Promise<void>; callbacks?: WorkerConversationCallbacks }) {
    const admissionId = randomUUID()
    const request = WorkerConversationRpcRequestSchema.parse({ ...structuredClone(input.request), admissionId })
    const admission: Admission = { request, channel: input.channel, current: input.current,
      callbacks: input.callbacks ?? {}, tail: Promise.resolve(), identities: new Map(), closed: false }
    this.admissions.set(admissionId, admission)
    const assertCurrent = async () => {
      if (admission.closed || this.admissions.get(admissionId) !== admission) denied()
      await admission.current()
      if (admission.closed || this.admissions.get(admissionId) !== admission) denied()
    }
    return {
      admissionId,
      async request(signal?: AbortSignal) {
        await assertCurrent()
        const reply = await admission.channel.request(request, signal ? { signal } : {})
        await assertCurrent()
        if (reply.bytes !== undefined) denied()
        return reply.payload
      },
      close: () => {
        admission.closed = true
        this.admissions.delete(admissionId)
      },
    }
  }

  private async current(admission: Admission, binding: WorkerConversationBinding,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    signal.throwIfAborted()
    if (admission.closed || !isDeepStrictEqual(admission.request.binding, binding)
      || !isDeepStrictEqual(admission.channel.binding, connection)) denied()
    await admission.current()
    signal.throwIfAborted()
    if (admission.closed) denied()
  }

  async handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<unknown> {
    const callback = WorkerConversationCallbackSchema.parse(raw)
    const admission = this.admissions.get(callback.admissionId)
    if (!admission) denied()
    await this.current(admission, callback.binding, connection, signal)
    if (callback.method === 'conversation.authorize') {
      if (!isDeepStrictEqual(admission.request, callback.request)) denied()
      return { authorized: true }
    }
    const task = admission.tail.then(async () => {
      await this.current(admission, callback.binding, connection, signal)
      if (callback.method === 'conversation.session-observed') {
        if (!['conversation.open', 'conversation.initial-turn'].includes(admission.request.method)
          || !admission.callbacks.sessionObserved || callback.session.harness !== callback.binding.harness) denied()
        if (admission.session && !isDeepStrictEqual(admission.session, callback.session)) denied()
        await admission.callbacks.sessionObserved(callback.session)
        admission.session = structuredClone(callback.session)
      } else if (callback.method === 'conversation.settings-applied') {
        const request = admission.request
        if (!('correlationId' in request) || request.correlationId !== callback.correlationId
          || !['conversation.start-turn', 'conversation.initial-turn'].includes(request.method)
          || !admission.callbacks.settingsApplied) denied()
        await admission.callbacks.settingsApplied()
      } else {
        const request = admission.request
        if (!('correlationId' in request) || request.correlationId !== callback.correlationId
          || !['conversation.start-turn', 'conversation.initial-turn'].includes(request.method)
          || !admission.callbacks.submitted) denied()
        const session = 'session' in request ? request.session : admission.session
        if (!session || callback.identity.nativeSubmission && (
          callback.identity.nativeSubmission.nativeSessionId !== session.nativeSessionId
          || callback.identity.nativeSubmission.clientCorrelationId !== callback.correlationId)) denied()
        const previous = admission.identities.get(callback.correlationId)
        if (previous?.nativeTurnId && callback.identity.nativeTurnId !== undefined
          && previous.nativeTurnId !== callback.identity.nativeTurnId
          || previous?.nativeSubmission && callback.identity.nativeSubmission
            && !isDeepStrictEqual(previous.nativeSubmission, callback.identity.nativeSubmission)) denied()
        const identity: Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'> = {
          ...(callback.identity.nativeTurnId !== undefined ? { nativeTurnId: callback.identity.nativeTurnId } : {}),
          ...(callback.identity.nativeSubmission !== undefined ? { nativeSubmission: callback.identity.nativeSubmission } : {}),
        }
        await admission.callbacks.submitted(callback.correlationId, identity)
        admission.identities.set(callback.correlationId, { ...previous, ...identity })
      }
      await this.current(admission, callback.binding, connection, signal)
      return { acknowledged: true }
    })
    admission.tail = task.then(() => undefined, () => undefined)
    return task
  }

  close() {
    for (const admission of this.admissions.values()) admission.closed = true
    this.admissions.clear()
  }
}
