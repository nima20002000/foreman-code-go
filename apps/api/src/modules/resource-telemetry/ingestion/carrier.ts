import { randomUUID } from 'node:crypto'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import {
  CollectionChallengeSchema, RESOURCE_TELEMETRY_CAPABILITY, TELEMETRY_LIMITS, telemetryCanonical,
  type ResourceCollector, type TelemetryIdentity, type TrustedTelemetryContext,
} from '@foreman-code/contracts/resource-telemetry'
import type { DeviceExtensionRegistration, DeviceApplicationRequestOptions } from '../../devices/deviceApplicationChannel.js'
import { resourceTelemetryExtension } from './ports.js'
import { ResourceTelemetryService, TelemetryRejected } from './service.js'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { DomainError } from '../../errors.js'

/** Ready/lost hooks retain only the exact authenticated channel's passive collector. */
export function createMainResourceTelemetryBindings(service: () => ResourceTelemetryService | undefined) {
  const sessions = new Map<string, Awaited<ReturnType<typeof startRemoteTelemetrySession>>>()
  const key = (binding: Readonly<DeviceSessionBinding>) => `${binding.deviceId}:${binding.connectionEpoch}`
  return {
    extension: mainResourceTelemetryExtension,
    async ready(binding: Readonly<DeviceSessionBinding>, signal: AbortSignal, endpoint: DeviceEndpoint) {
      const reader = service(), captured = endpoint.captureRequest(binding.deviceId, resourceTelemetryExtension.namespace)
      if (!reader || !captured || telemetryCanonical(captured.binding) !== telemetryCanonical(binding)) return
      const session = await startRemoteTelemetrySession({ service: reader, binding, signal,
        request: (payload, options) => captured.request(payload, options) })
      if (signal.aborted) { await session.close(); signal.throwIfAborted() }
      sessions.set(key(binding), session)
      return session
    },
    async lost(binding: Readonly<DeviceSessionBinding>) {
      const id = key(binding), session = sessions.get(id)
      sessions.delete(id)
      await session?.close()
    },
  }
}

export const mainResourceTelemetryExtension: DeviceExtensionRegistration = { ...resourceTelemetryExtension, role: 'client' }
export const remoteTelemetryContext = (binding: Readonly<DeviceSessionBinding>): Extract<TrustedTelemetryContext, { kind: 'remote' }> =>
  ({ kind: 'remote', binding: { ...binding }, capability: RESOURCE_TELEMETRY_CAPABILITY })

/** W07 owns the socket and authentication. This task owns only passive telemetry for that exact connection. */
export async function startRemoteTelemetrySession(input: {
  service: ResourceTelemetryService; binding: Readonly<DeviceSessionBinding>; signal: AbortSignal
  request(payload: unknown, options: DeviceApplicationRequestOptions): Promise<DeviceApplicationResult>
}) {
  const context = remoteTelemetryContext(input.binding), lifetime = new AbortController()
  // Transport loss stops captures; W07 presence and live grant checks govern offline lastKnown.
  const abort = () => lifetime.abort(input.signal.reason)
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  try { await input.service.handshake(context, randomUUID(), lifetime.signal) }
  catch (error) { input.signal.removeEventListener('abort', abort); throw error }
  const completion = (async () => {
    try {
      while (!lifetime.signal.aborted) {
        const issuedMono = input.service.ports.clock.monotonicMs()
        const challenge = await input.service.challenge(context, lifetime.signal)
        if (challenge) {
          // A busy channel only misses this sample; its stale age keeps readers from using it.
          const reply = await input.request({ operation: 'collect', challenge }, { signal: lifetime.signal, timeoutMs: TELEMETRY_LIMITS.freshMs })
            .catch(error => {
              if (!lifetime.signal.aborted && error instanceof DeviceApplicationError
                && (error.code === 'timeout' || error.code === 'backpressure')) return undefined
              throw error
            })
          lifetime.signal.throwIfAborted()
          if (reply?.bytes !== undefined) throw new TelemetryRejected('binary')
          if (reply) {
            try { await input.service.ingest(context, JSON.stringify(reply.payload), lifetime.signal) }
            catch (error) {
              if (!(error instanceof TelemetryRejected) || error.reason !== 'owner-binding' && error.reason !== 'challenge') throw error
            }
          }
        }
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve() }
          const elapsed = input.service.ports.clock.monotonicMs() - issuedMono
          const timer = setTimeout(done, elapsed >= TELEMETRY_LIMITS.intervalMs ? TELEMETRY_LIMITS.intervalMs : TELEMETRY_LIMITS.intervalMs - Math.max(0, elapsed))
          lifetime.signal.addEventListener('abort', done, { once: true })
          if (lifetime.signal.aborted) done()
        })
      }
    } catch (error) { if (!lifetime.signal.aborted) throw error }
    finally { abort(); input.signal.removeEventListener('abort', abort) }
  })()
  // The composition owner observes completion; install a rejection observer immediately.
  void completion.catch(() => { /* ignore: the rejection is handled by whoever consumes this promise; this only prevents an unhandled-rejection report */ })
  return { completion, async close() { abort(); await completion.catch(error => { if (!input.signal.aborted) throw error }) } }
}

/** Worker initialization uses connection lifetime, never an individual request's cancellation signal. */
export function createWorkerResourceTelemetryExtension(input: {
  signal: AbortSignal
  currentBinding(): Readonly<DeviceSessionBinding> | null | undefined
  createCollector(identity: TelemetryIdentity, signal: AbortSignal): Promise<ResourceCollector>
}) {
  let active: { identity: TelemetryIdentity; binding: Readonly<DeviceSessionBinding>; collector: ResourceCollector;
    lifetime: AbortController; pump: Promise<void> } | undefined
  let tail = Promise.resolve(), closed = false, admitted = 0
  const waiting = new Map<string, { resolve(payload: unknown): void; reject(error: unknown): void }>()
  const current = (binding: Readonly<DeviceSessionBinding>) => {
    input.signal.throwIfAborted()
    if (closed) throw new TelemetryRejected('session-generation')
    let live: ReturnType<typeof input.currentBinding>
    try {
      live = input.currentBinding()
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WORKER_DOMAIN_UNAVAILABLE') {
        throw new TelemetryRejected('session-generation')
      }
      throw error
    }
    if (telemetryCanonical(live) !== telemetryCanonical(binding)) throw new TelemetryRejected('session-generation')
  }
  const stop = async () => {
    const old = active; active = undefined
    if (!old) return
    old.lifetime.abort()
    for (const waiter of waiting.values()) waiter.reject(new TelemetryRejected('session-generation'))
    waiting.clear()
    try { await old.collector.close() } finally { await old.pump }
  }
  const extension: DeviceExtensionRegistration = { ...resourceTelemetryExtension, role: 'server', async handle(payload, context) {
    current(context.binding)
    if (context.bytes !== undefined || !payload || typeof payload !== 'object'
      || Object.keys(payload).sort().join(',') !== 'challenge,operation' || (payload as { operation?: unknown }).operation !== 'collect') throw new TelemetryRejected('schema')
    const challenge = CollectionChallengeSchema.parse((payload as { challenge: unknown }).challenge)
    const b = context.binding, identity = challenge.identity
    if (identity.mainId !== b.mainId || telemetryCanonical(identity.host) !== telemetryCanonical({
      hostRef: { kind: 'device', mainId: b.mainId, deviceId: b.deviceId }, deviceId: b.deviceId,
      applicationInstallationId: b.workerInstallationId, bootId: b.bootId, runtimeEpoch: b.connectionEpoch,
      keyRevision: b.keyRevision, authorizationRevision: b.authorizationRevision, connectionGeneration: b.connectionGeneration,
      collectorGeneration: identity.host.collectorGeneration })) throw new TelemetryRejected('identity')
    if (admitted >= TELEMETRY_LIMITS.queuedFrames) throw new TelemetryRejected('backpressure')
    admitted++
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    try {
      await previous; current(b); context.signal.throwIfAborted()
      if (active && (telemetryCanonical(active.identity) !== telemetryCanonical(identity) || telemetryCanonical(active.binding) !== telemetryCanonical(b))) await stop()
      if (!active) {
        const lifetime = new AbortController()
        const abort = () => lifetime.abort(input.signal.reason)
        input.signal.addEventListener('abort', abort, { once: true })
        let collector: ResourceCollector | undefined
        try { collector = await input.createCollector(identity, lifetime.signal); current(b) }
        catch (error) { lifetime.abort(); input.signal.removeEventListener('abort', abort); await collector?.close(); throw error }
        const initialized = collector
        const pump = (async () => {
          try {
            for await (const batch of initialized.samples(lifetime.signal)) {
              current(b)
              const waiter = waiting.get(batch.challengeId)
              if (waiter) { waiting.delete(batch.challengeId); waiter.resolve(batch) }
            }
            if (!lifetime.signal.aborted) throw new TelemetryRejected('collector-ended')
          } catch (error) {
            const cancelled = lifetime.signal.aborted
              || error instanceof TelemetryRejected && error.reason === 'session-generation'
            lifetime.abort(error)
            for (const waiter of waiting.values()) waiter.reject(error)
            waiting.clear()
            if (!cancelled) throw error
          }
          finally { input.signal.removeEventListener('abort', abort) }
        })()
        void pump.catch(() => { /* ignore: the rejection is handled by whoever consumes this promise; this only prevents an unhandled-rejection report */ })
        active = { identity: structuredClone(identity), binding: { ...b }, collector: initialized, lifetime, pump }
      }
      if (waiting.has(challenge.challengeId) || waiting.size >= TELEMETRY_LIMITS.outstanding) throw new TelemetryRejected('backpressure')
      let reject!: (error: unknown) => void
      const sample = new Promise<unknown>((resolve, fail) => { reject = fail; waiting.set(challenge.challengeId, { resolve, reject: fail }) })
      void sample.catch(() => { /* ignore: the rejection is handled by whoever consumes this promise; this only prevents an unhandled-rejection report */ })
      const cancel = () => { waiting.delete(challenge.challengeId); reject(new TelemetryRejected('cancelled')) }
      context.signal.addEventListener('abort', cancel, { once: true })
      try {
        active.lifetime.signal.throwIfAborted()
        if (active.collector.offer(challenge) !== 'accepted') throw new TelemetryRejected('challenge')
        const result = await sample; current(b); context.signal.throwIfAborted()
        return { payload: result }
      } finally { context.signal.removeEventListener('abort', cancel); waiting.delete(challenge.challengeId) }
    } finally { admitted--; release() }
  } }
  return { extension, async close() { closed = true; await stop(); await tail } }
}
