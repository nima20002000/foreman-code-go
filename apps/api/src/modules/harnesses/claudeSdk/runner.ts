import { ClaudeBoundedQueue } from './queue.js'
import type {
  ClaudeNativeObservation, ClaudePersistedSession, ClaudeSdkClient, ClaudeSdkOpenInput,
  ClaudeSdkOutput, ClaudeSdkQuery, ClaudeSdkRunner, ClaudeSdkSession, ClaudeSdkUserMessage, ClaudeSessionScope,
} from './port.js'

export function assertClaudeSessionScope(session: ClaudePersistedSession, scope: ClaudeSessionScope): void {
  for (const key of ['deviceId', 'profilePath', 'configRevision', 'cwd'] as const) {
    if (session[key] !== scope[key]) throw new Error(`Claude session ${key} mismatch`)
  }
}

function observationOf(raw: unknown): ClaudeNativeObservation | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const frame = raw as Record<string, unknown>
  if (typeof frame.session_id !== 'string' || !frame.session_id) return undefined
  if (frame.parent_tool_use_id != null) return undefined
  if (!['assistant', 'stream_event', 'result'].includes(String(frame.type))) return undefined
  const uuids = Array.isArray(frame.user_message_uuids)
    ? frame.user_message_uuids.filter((value): value is string => typeof value === 'string') : []
  if (typeof frame.user_message_uuid === 'string' && !uuids.includes(frame.user_message_uuid)) uuids.push(frame.user_message_uuid)
  if (!uuids.length) return undefined
  return {
    nativeSessionId: frame.session_id, promptUuids: uuids,
    kind: frame.type === 'result' ? 'result' : 'reply',
    ...(typeof frame.uuid === 'string' ? { providerMessageId: frame.uuid } : {}),
  }
}

/** Aborting local consumption settles next() even when an SDK generator ignores return(). */
function nextOwned(iterator: AsyncIterator<unknown>, signal: AbortSignal): Promise<IteratorResult<unknown>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => iterator.next()).then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(error) },
    )
  })
}

export function createClaudeSdkRunner(input: {
  loadClient(): Promise<ClaudeSdkClient>
  inputCapacity?: number
  outputCapacity?: number
  receiptCapacity?: number
}): ClaudeSdkRunner {
  const sessions = new Set<ClaudeSdkSession>()
  const openings = new Set<Promise<ClaudeSdkSession>>()
  let disposed = false
  const runner: ClaudeSdkRunner = {
    open(options) {
      if (disposed) return Promise.reject(new Error('Claude runner disposed'))
      const opening = openSession(options)
      openings.add(opening)
      void opening.then(() => openings.delete(opening), () => openings.delete(opening))
      return opening
    },
    async fork(source, target, signal) {
      signal?.throwIfAborted()
      if (disposed) throw new Error('Claude runner disposed')
      assertClaudeSessionScope(source, target)
      const client = await input.loadClient()
      signal?.throwIfAborted()
      const info = await client.getSessionInfo(source.nativeSessionId, { dir: source.cwd })
      if (!info || info.sessionId !== source.nativeSessionId) throw new Error('Exact Claude source session is unavailable')
      signal?.throwIfAborted()
      const fork = await client.forkSession(source.nativeSessionId, { dir: source.cwd })
      if (!fork.sessionId || fork.sessionId === source.nativeSessionId) throw new Error('Claude fork did not return a new native session')
      return { ...target, nativeSessionId: fork.sessionId }
    },
    async history(session, scope, signal, page) {
      signal?.throwIfAborted()
      assertClaudeSessionScope(session, scope)
      const client = await input.loadClient()
      signal?.throwIfAborted()
      return client.getSessionMessages(session.nativeSessionId, { dir: session.cwd, limit: page?.limit ?? 256, offset: page?.offset ?? 0 })
    },
    async dispose() {
      disposed = true
      const result = await Promise.allSettled([...sessions].map((session) => session.close()))
      await Promise.allSettled([...openings])
      const errors = result.flatMap((entry) => entry.status === 'rejected' ? [entry.reason as unknown] : [])
      if (errors.length) throw new AggregateError(errors, 'Claude runner cleanup failed')
    },
  }
  async function openSession(options: ClaudeSdkOpenInput): Promise<ClaudeSdkSession> {
    options.signal?.throwIfAborted()
    if ('continue' in options.options || 'resume' in options.options || 'forkSession' in options.options || 'sessionId' in options.options) {
      throw new Error('Claude session selection must use the exact runner identity port')
    }
    if ((typeof options.options.canUseTool === 'function' || options.options.hooks && Object.keys(options.options.hooks as object).length > 0) && !options.cancelPendingRequests) {
      throw new Error('Claude process-local callbacks require an explicit pending-request cleanup owner')
    }
    if (options.resume) assertClaudeSessionScope(options.resume, options.scope)
    const abort = new AbortController()
    const inputQueue = new ClaudeBoundedQueue<ClaudeSdkUserMessage>(input.inputCapacity ?? 8)
    const outputQueue = new ClaudeBoundedQueue<ClaudeSdkOutput>(input.outputCapacity ?? 256)
    const receipts = new Map<string, ClaudeNativeObservation[]>()
    const offered = new Set<string>()
    let nativeSessionId: string | undefined
    let query: ClaudeSdkQuery | undefined
    let pump: Promise<void> | undefined
    let closing: Promise<void> | undefined
    let closeFailure: unknown
    let stopped = false
    const stop = () => {
      if (stopped) return
      const errors: unknown[] = []
      try { options.cancelPendingRequests?.() } catch (error) { errors.push(error) }
      inputQueue.close(undefined, true)
      abort.abort(new Error('Claude session closed'))
      try { query?.close() } catch (error) { errors.push(error) }
      outputQueue.close()
      if (errors.length) closeFailure = new AggregateError(errors, 'Claude SDK close failed')
      else { stopped = true; closeFailure = undefined }
    }
    const externalAbort = () => { void session.close().catch(() => undefined) }
    const session: ClaudeSdkSession = {
      output: outputQueue,
      get nativeSessionId() { return nativeSessionId },
      async offer(message, signal) {
        signal?.throwIfAborted()
        abort.signal.throwIfAborted()
        if (!message.promptUuid || offered.has(message.promptUuid)) throw new Error('Claude prompt identity missing or already offered; never replay uncertain input')
        if (offered.size >= (input.receiptCapacity ?? 256)) throw new Error('Claude receipt window exhausted')
        inputQueue.offer({ type: 'user', message: { role: 'user', content: message.content }, parent_tool_use_id: null, uuid: message.promptUuid })
        offered.add(message.promptUuid)
        return { state: 'queue-offered', promptUuid: message.promptUuid }
      },
      async interrupt() {
        abort.signal.throwIfAborted()
        if (!query) throw new Error('Claude SDK not initialized')
        // This is a session-wide native interrupt, not expected-turn cancellation proof.
        return query.interrupt()
      },
      async initializationResult() {
        abort.signal.throwIfAborted()
        if (!query?.initializationResult) throw new Error('Claude SDK initialization inspection is unavailable')
        return query.initializationResult()
      },
      async mcpServerStatus() {
        abort.signal.throwIfAborted()
        if (!query?.mcpServerStatus) throw new Error('Claude SDK live MCP control inspection is unavailable')
        return query.mcpServerStatus()
      },
      async setMcpServers(servers) {
        abort.signal.throwIfAborted()
        if (!query?.setMcpServers) throw new Error('Claude SDK scoped MCP control update is unavailable')
        return query.setMcpServers(servers)
      },
      reconcile(promptUuid) { return [...(receipts.get(promptUuid) ?? [])] },
      close() {
        if (closing) return closing
        closing = (async () => {
          stop()
          await pump
          await query?.joinClosed?.()
          options.signal?.removeEventListener('abort', externalAbort)
          if (closeFailure !== undefined) throw closeFailure
          sessions.delete(session)
        })()
        // Failed cleanup remains owned and retryable; no process-closure receipt is fabricated.
        void closing.catch(() => { closing = undefined })
        return closing
      },
      async closeForRestart() { throw new Error('Claude native restart detachment is unqualified; query.close terminates native work') },
    }
    sessions.add(session)
    options.signal?.addEventListener('abort', externalAbort, { once: true })
    try {
      const client = await input.loadClient()
      abort.signal.throwIfAborted()
      if (disposed) throw new Error('Claude runner disposed during startup')
      if (options.resume) {
        const info = await client.getSessionInfo(options.resume.nativeSessionId, { dir: options.scope.cwd })
        abort.signal.throwIfAborted()
        if (!info || info.sessionId !== options.resume.nativeSessionId) throw new Error('Exact Claude session history is unavailable')
      }
      query = client.query({ prompt: inputQueue, options: {
        ...options.options, cwd: options.scope.cwd, abortController: abort,
        env: { ...(options.options.env as Record<string, string> | undefined),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}), CLAUDE_CONFIG_DIR: options.scope.profilePath },
        ...(options.resume ? { resume: options.resume.nativeSessionId } : {}),
      } })
      // The Query itself owns close(), unlike a wrapping async generator's blocked return().
      const iterator = query[Symbol.asyncIterator]()
      pump = (async () => {
        try {
          while (!abort.signal.aborted) {
            const next = await nextOwned(iterator, abort.signal)
            if (next.done) break
            const raw = next.value
            const frame = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined
            if (typeof frame?.session_id === 'string') {
              if (nativeSessionId && nativeSessionId !== frame.session_id) throw new Error('Claude native session identity changed')
              if (options.resume && options.resume.nativeSessionId !== frame.session_id) throw new Error('Claude resumed a different native session')
              nativeSessionId = frame.session_id
            }
            const observation = observationOf(raw)
            if (observation) {
              const ownedUuids = observation.promptUuids.filter((uuid) => offered.has(uuid))
              if (ownedUuids.length) {
                const owned = { ...observation, promptUuids: ownedUuids }
                await options.onObservation?.(owned)
                for (const uuid of ownedUuids) {
                  const prior = receipts.get(uuid) ?? []
                  // Keep first acceptance and latest terminal, not every text delta.
                  if (!prior.length || owned.kind === 'result') receipts.set(uuid, [...prior.slice(0, 1), owned])
                }
              }
            }
            outputQueue.offer({ raw, ...(observation ? { observation } : {}) })
          }
          outputQueue.close()
        } catch (error) {
          if (!abort.signal.aborted) {
            // Queued authoritative results survive a following SDK exception.
            outputQueue.close(error)
            stop()
          }
        }
      })()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }
  return runner
}
