import type { AgentHarness } from '@graphql/contracts'
import { DomainError } from '../errors.js'
import type { NativeMcpInspector } from './mcpDetection.js'
import type { NativeHarnessSessionManager } from './port.js'
import { unavailableNativeResponse } from './responseAvailability.js'

/** One async domain admission behind the existing synchronous role factory.
 * The returned lifetime owns initialization and its actual adapter cleanup. */
export function createAdmittedNativeManager<T extends NativeHarnessSessionManager>(harness: AgentHarness,
  initialize: (signal: AbortSignal) => Promise<{ manager: T; inspector?: NativeMcpInspector }>) {
  const lifetime = new AbortController()
  let allocation: { manager: T; inspector?: NativeMcpInspector } | undefined
  let opening: Promise<{ manager: T; inspector?: NativeMcpInspector }> | undefined
  let disposal: Promise<void> | undefined
  const stopped = new Map<string, Parameters<NonNullable<NativeHarnessSessionManager['stopAutomaticResponses']>>[0]>()
  const actual = async (signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
    opening ??= Promise.resolve().then(() => initialize(lifetime.signal)).then(async result => {
      allocation = result
      if (lifetime.signal.aborted || result.manager.harness !== harness) {
        await result.manager.dispose?.()
        if (lifetime.signal.aborted) throw lifetime.signal.reason
        throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The admitted native adapter differs from its role configuration.', 409)
      }
      for (const session of stopped.values()) result.manager.stopAutomaticResponses?.(session)
      return result
    })
    const result = await opening
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
    return result.manager
  }
  const manager: NativeHarnessSessionManager = {
    harness,
    capabilities: async signal => (await actual(signal)).capabilities(signal),
    inspectMcp: async signal => (await actual(signal)).inspectMcp(signal),
    createSession: async (start, signal) => (await actual(signal)).createSession(start, signal),
    attachSession: async (session, start, signal) => (await actual(signal)).attachSession(session, start, signal),
    async *startTurn(session, input, signal) { yield* (await actual(signal)).startTurn(session, input, signal) },
    forkSession: async (source, start, signal) => {
      const current = await actual(signal)
      if (!current.forkSession) throw new DomainError('HARNESS_FORK_UNAVAILABLE', 'The admitted driver has no fork capability.', 409)
      return current.forkSession(source, start, signal)
    },
    pending: async (session, signal) => (await actual(signal)).pending(session, signal),
    respond: async (session, requestId, option, signal) => (await actual(signal)).respond(session, requestId, option, signal),
    stopAutomaticResponses(session) { stopped.set(session.nativeSessionId, session); allocation?.manager.stopAutomaticResponses?.(session) },
    cancel: async (session, signal, turnId) => (await actual(signal)).cancel(session, signal, turnId),
    subagentHistory: async (session, cursor, signal) => {
      const current = await actual(signal)
      if (!current.subagentHistory) throw new DomainError('SUBAGENT_HISTORY_UNAVAILABLE', 'The admitted driver has no child history reader.', 409)
      return current.subagentHistory(session, cursor, signal)
    },
    subagentControl: (child, assertOwner) => lifetime.signal.aborted ? undefined
      : allocation?.manager.subagentControl?.(child, () => { lifetime.signal.throwIfAborted(); assertOwner() }),
    history: async (session, signal) => (await actual(signal)).history(session, signal),
    reconcile: async (session, correlationId, signal) => (await actual(signal)).reconcile(session, correlationId, signal),
    reconcileResponse: async (session, response, signal) => {
      const current = await actual(signal)
      return current.reconcileResponse ? current.reconcileResponse(session, response, signal) : current.history(session, signal)
    },
    inspectResponseAvailability: async (session, query, signal) => {
      const current = await actual(signal)
      return current.inspectResponseAvailability ? current.inspectResponseAvailability(session, query, signal) : unavailableNativeResponse(session, query, 'unsupported')
    },
    close: async session => (await actual()).close(session),
    closeForRestart: async session => {
      const current = await actual()
      if (!current.closeForRestart) throw new DomainError('HARNESS_RESTART_UNAVAILABLE', 'The admitted driver has no restart capability.', 409)
      return current.closeForRestart(session)
    },
    dispose() {
      lifetime.abort(new DomainError('NATIVE_MANAGER_DISPOSED', 'The admitted native allocation is disposed.', 409))
      disposal ??= Promise.resolve().then(async () => {
        if (opening) await opening.catch(() => undefined)
        await allocation?.manager.dispose?.(); stopped.clear()
      })
      const attempt = disposal
      void attempt.catch(() => { if (disposal === attempt) disposal = undefined })
      return attempt
    },
  }
  // Keep provider capabilities observable through the original port. OpenCode
  // has no exact-turn steering; Codex has no paged server-history primitive.
  if (harness === 'codex') {
    manager.steerTurn = async (session, input, signal) => {
      const current = await actual(signal)
      if (!current.steerTurn) throw new DomainError('HARNESS_STEER_UNAVAILABLE', 'The admitted driver cannot steer this turn.', 409)
      return current.steerTurn(session, input, signal)
    }
    manager.reconcileSteers = async (session, inputs, signal) => (await actual(signal)).reconcileSteers?.(session, inputs, signal) ?? []
  }
  if (harness === 'opencode') manager.historyPage = async (session, before, signal) => {
    const current = await actual(signal)
    return current.historyPage ? current.historyPage(session, before, signal) : current.history(session, signal)
  }
  const inspector: NativeMcpInspector = { async inspect(request) {
    await actual(request.signal)
    if (!allocation?.inspector) throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The admitted driver has no MCP inspector.', 503)
    return allocation.inspector.inspect(request)
  } }
  return { manager, inspector, actual, peek: () => lifetime.signal.aborted ? undefined : allocation?.manager }
}
