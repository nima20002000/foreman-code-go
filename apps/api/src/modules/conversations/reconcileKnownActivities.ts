import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { PostgresOperatorActivityRepository } from './operatorActivityRepository.js'
import type { NativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { knownNativeActivity } from './knownNativeActivity.js'

/** Existing reconciler only. Idle/cold records never allocate, attach, replay a prompt or infer child success. */
export async function reconcileKnownActivities(input: {
  kind: 'agent' | 'operator'; conversationId?: string; activity: PostgresOperatorActivityRepository; signal: AbortSignal;
  runtimeFor(id: string): { manager: NativeHarnessSessionManager; session: NativeSessionReference; redact?: NativePersistenceRedactor } | undefined;
  publish(id: string, settled: NonNullable<Awaited<ReturnType<PostgresOperatorActivityRepository['settleKnownByNative']>>>): void;
}) {
  const { owners } = await input.activity.unfinishedOwners(input.kind, input.conversationId)
  const visited = new Set<string>()
  for (const owner of owners) {
    if (visited.has(owner.conversationId) || input.signal.aborted) continue
    visited.add(owner.conversationId)
    const runtime = input.runtimeFor(owner.conversationId)
    if (!runtime || runtime.manager.harness !== 'codex' || runtime.session.nativeSessionId !== owner.ownerNative.sessionId) continue
    let history
    try { history = await runtime.manager.history(runtime.session, input.signal) } catch { continue }
    const current = input.runtimeFor(owner.conversationId)
    if (!current || current.manager !== runtime.manager || current.session.nativeSessionId !== runtime.session.nativeSessionId || input.signal.aborted) continue
    for (const event of history.events) {
      const known = knownNativeActivity(event, runtime.manager.harness)
      if (!known) continue
      const settled = await input.activity.settleKnownByNative(owner.conversationId, known.change, known.native, runtime.redact)
      if (settled) input.publish(owner.conversationId, settled)
    }
  }
  return owners.some((owner) => !input.conversationId || owner.conversationId === input.conversationId)
}
