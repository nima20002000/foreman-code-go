import { ClaudeInputNotDeliveredError } from './port.js'
import { readClaudeCompactionResult, saveClaudeCompactionResult, claudeCompactionResultMatches } from './compactionResults.js'
import { readClaudeCompactionHistory } from './compactionHistory.js'
import { ClaudeBoundedQueue } from './queue.js'
import { isDeepStrictEqual } from 'node:util'
import type {
  ClaudeNativeObservation, ClaudePersistedSession, ClaudeSdkClient, ClaudeSdkOpenInput,
  ClaudeSdkOutput, ClaudeSdkQuery, ClaudeSdkRunner, ClaudeSdkSession, ClaudeSdkUserMessage, ClaudeSessionScope,
} from './port.js'
import { ignoreError } from '../../diagnostics/ignoredError.js'



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

function responseObservations(continuation: (frame: Record<string, unknown>) => Promise<readonly string[] | undefined>) {
  const owners = new Map<string, readonly string[]>()
  const finished = new Set<string>()
  let response: readonly string[] | undefined
  let stream: readonly string[] | undefined
  let streamMessageId: string | undefined
  return async (raw: unknown): Promise<ClaudeNativeObservation | undefined> => {
    if (!raw || typeof raw !== 'object') return undefined
    const frame = raw as Record<string, unknown>
    if (typeof frame.session_id !== 'string' || !frame.session_id || frame.parent_tool_use_id != null) return undefined
    if (!['assistant', 'stream_event', 'result'].includes(String(frame.type))) return undefined
    const message = frame.message as { id?: unknown } | undefined
    const event = frame.event as { type?: unknown; message?: { id?: unknown } } | undefined
    const messageId = message?.id ?? event?.message?.id
    const ids: string[] = []
    if (typeof frame.uuid === 'string' && (frame.type !== 'stream_event' || event?.type === 'message_start')) {
      ids.push(`frame:${frame.uuid}`)
    }
    if (typeof messageId === 'string') ids.push(`message:${messageId}`)
    if (frame.type === 'stream_event' && event?.type === 'message_start') {
      streamMessageId = typeof messageId === 'string' ? messageId : undefined
    }
    const echo = observationOf(raw)
    if (echo && frame.type === 'stream_event' && streamMessageId && !ids.includes(`message:${streamMessageId}`)) {
      ids.push(`message:${streamMessageId}`)
    }
    const known = ids.map(id => owners.get(id)).find(owner => owner !== undefined)
    if (echo && known && !isDeepStrictEqual(echo.promptUuids, known)) {
      throw new Error('Claude response identity was reused for another input')
    }
    // New API messages require transcript ancestry; arrival order cannot establish ownership.
    let promptUuids = echo?.promptUuids ?? (frame.type === 'result' ? undefined : known)
    if (!promptUuids && frame.type !== 'result') {
      promptUuids = frame.type === 'stream_event' && event?.type !== 'message_start'
        ? stream : await continuation(frame)
    }
    if (echo?.kind === 'reply' && !known && !echo.promptUuids.some(uuid => finished.has(uuid))) {
      response = echo.promptUuids
      if (frame.type === 'stream_event') stream = echo.promptUuids
    }
    if (frame.type === 'stream_event' && event?.type === 'message_start') stream = promptUuids
    if (promptUuids) {
      for (const id of ids) {
        const previous = owners.get(id)
        if (previous && !isDeepStrictEqual(previous, promptUuids)) {
          throw new Error('Claude response identity was reused for another input')
        }
        owners.set(id, promptUuids)
      }
    }
    if (frame.type === 'result') {
      for (const uuid of promptUuids ?? []) finished.add(uuid)
      if (promptUuids && isDeepStrictEqual(promptUuids, response)) {
        response = undefined
        stream = undefined
        streamMessageId = undefined
      }
    }
    if (!promptUuids) return undefined
    return { nativeSessionId: frame.session_id, promptUuids, kind: frame.type === 'result' ? 'result' : 'reply',
      ...(typeof frame.uuid === 'string' ? { providerMessageId: frame.uuid } : {}) }
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
  let queryDispatched = false
  const runner: ClaudeSdkRunner = {
    requiresRuntimeClosure: () => queryDispatched,
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
    async compactionOutcome(session, scope, promptUuid) {
      assertClaudeSessionScope(session, scope)
      return readClaudeCompactionResult(session, promptUuid)
    },
    async compactionHistory(session, scope, cursor, signal) {
      assertClaudeSessionScope(session, scope)
      return readClaudeCompactionHistory(session, cursor, signal)
    },
    async history(session, scope, signal, page) {
      signal?.throwIfAborted()
      assertClaudeSessionScope(session, scope)
      const client = await input.loadClient()
      signal?.throwIfAborted()
      return client.getSessionMessages(session.nativeSessionId, { dir: session.cwd, limit: page?.limit ?? 256, offset: page?.offset ?? 0 })
    },
    async subagentHistory(session, scope, agentId, offset = 0, signal) {
      signal?.throwIfAborted()
      assertClaudeSessionScope(session, scope)
      if (disposed) throw new Error('Claude runner disposed')
      const client = await input.loadClient()
      if (!client.listSubagents || !client.getSubagentMessages) throw new Error('The pinned SDK child read helper is unavailable')
      const info = await client.getSessionInfo(session.nativeSessionId, { dir: scope.cwd })
      if (info?.sessionId !== session.nativeSessionId) throw new Error('Exact parent history is unavailable')
      const agentIds = [...new Set(await client.listSubagents(session.nativeSessionId, { dir: scope.cwd }))].sort()
      signal?.throwIfAborted()
      if (agentIds.length > 32 || agentIds.some(id => !id || id.length > 512)) throw new Error('Native child roster exceeds its bound')
      const target = agentId ?? agentIds[0]
      if (!target) return { agentIds, messages: [], hasMore: false }
      if (!agentIds.includes(target)) throw new Error('Child transcript does not belong to this exact parent')
      const messages = await client.getSubagentMessages(session.nativeSessionId, target, { dir: scope.cwd, limit: 51, offset })
      signal?.throwIfAborted()
      if (messages.length > 51) throw new Error('Native child transcript page exceeds its bound')
      return { agentIds, agentId: target, messages: messages.slice(0, 50), hasMore: messages.length > 50 }
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
    let client: ClaudeSdkClient | undefined
    const observeResponse = responseObservations(async frame => {
      const messageId = (frame.message as { id?: unknown } | undefined)?.id
        ?? ((frame.event as { message?: { id?: unknown } } | undefined)?.message?.id)
      if (typeof messageId !== 'string' && typeof frame.uuid !== 'string') return undefined
      let owner: string | undefined
      const ancestry = new Map<string, string | undefined>()
      // getSessionMessages returns the SDK's parentUuid-linked root conversation chain.
      // Tool-result user records continue it; a new prompt creates a new input boundary.
      for (let offset = 0; ; offset += 256) {
        abort.signal.throwIfAborted()
        const page = await client!.getSessionMessages(String(frame.session_id), { dir: options.scope.cwd, offset, limit: 256 })
        for (const raw of page) {
          if (!raw || typeof raw !== 'object') continue
          const entry = raw as Record<string, unknown>
          if (entry.session_id !== frame.session_id || entry.parent_tool_use_id != null) continue
          const message = entry.message as { id?: unknown; content?: unknown } | undefined
          const parentOwner = typeof entry.parentUuid === 'string' ? ancestry.get(entry.parentUuid) : owner
          if (entry.type === 'user') {
            const content = message?.content
            const toolResult = Array.isArray(content) && content.some(block => block && typeof block === 'object'
              && (block as { type?: unknown }).type === 'tool_result')
            if (entry.isCompactSummary === true) {
              // The SDK omits parentUuid after selecting its native ancestry chain.
              owner = parentOwner
            } else if (!toolResult) {
              owner = typeof entry.uuid === 'string' ? entry.uuid : undefined
            } else {
              owner = parentOwner
            }
          } else {
            owner = parentOwner
          }
          if (typeof entry.uuid === 'string') ancestry.set(entry.uuid, owner)
          if (entry.type === 'assistant' && (entry.uuid === frame.uuid || messageId && message?.id === messageId)) {
            return owner && offered.has(owner) ? [owner] : undefined
          }
        }
        if (page.length < 256) return undefined
      }
    })
    let compact: { promptUuid: string; boundary: boolean } | undefined
    let nativeSessionId: string | undefined
    let query: ClaudeSdkQuery | undefined
    let queryOpening: Promise<ClaudeSdkQuery> | undefined
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
    const externalAbort = () => {
      abort.abort(options.signal?.reason)
      void session.close().catch(ignoreError('harness', 'session.close', { module: 'harnesses/claudeSdk/runner' }))
    }
    const session: ClaudeSdkSession = {
      output: outputQueue,
      get nativeSessionId() { return nativeSessionId },
      assertInputCapacity() {
        if (offered.size >= (input.receiptCapacity ?? 256)) {
          throw new ClaudeInputNotDeliveredError('Claude receipt window exhausted; resume the completed session before offering input.')
        }
      },
      async offer(message, signal) {
        signal?.throwIfAborted()
        abort.signal.throwIfAborted()
        if (!message.promptUuid || offered.has(message.promptUuid)) throw new Error('Claude prompt identity missing or already offered; never replay uncertain input')
        session.assertInputCapacity()
        offered.add(message.promptUuid)
        if (message.content === '/compact') compact = { promptUuid: message.promptUuid, boundary: false }
        await inputQueue.offer({ type: 'user', message: { role: 'user', content: message.content }, parent_tool_use_id: null, uuid: message.promptUuid }, signal)
        abort.signal.throwIfAborted()
        return { state: 'queue-offered', promptUuid: message.promptUuid }
      },
      async getContextUsage(options) {
        abort.signal.throwIfAborted()
        if (!query?.getContextUsage) throw new Error('Claude SDK context inspection is unavailable')
        return query.getContextUsage(options)
      },
      async setPermissionMode(mode) {
        abort.signal.throwIfAborted()
        if (!query?.setPermissionMode) throw new Error('Claude SDK Plan control is unavailable')
        await query.setPermissionMode(mode)
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
          if (!query && queryOpening) {
            const [opened] = await Promise.allSettled([queryOpening])
            if (opened?.status === 'fulfilled') {
              query = opened.value
              query.close()
            }
          }
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
      client = await input.loadClient()
      abort.signal.throwIfAborted()
      if (disposed) throw new Error('Claude runner disposed during startup')
      if (options.resume) {
        const info = await client.getSessionInfo(options.resume.nativeSessionId, { dir: options.scope.cwd })
        abort.signal.throwIfAborted()
        if (!info || info.sessionId !== options.resume.nativeSessionId) throw new Error('Exact Claude session history is unavailable')
      }
      queryOpening = Promise.resolve(client.query({ prompt: inputQueue, scope: options.scope, options: {
        ...options.options, cwd: options.scope.cwd, abortController: abort,
        env: { ...(options.options.env as Record<string, string> | undefined),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}), CLAUDE_CONFIG_DIR: options.scope.profilePath },
        ...(options.resume ? { resume: options.resume.nativeSessionId } : {}),
      } }))
      query = await queryOpening
      queryDispatched = true
      abort.signal.throwIfAborted()
      if (disposed) throw new Error('Claude runner disposed during query startup')
      // The Query itself owns close(), unlike a wrapping async generator's blocked return().
      if (!query.getContextUsage) delete session.getContextUsage
      if (!query.setPermissionMode) delete session.setPermissionMode
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
            if (compact && frame?.type === 'system' && frame.subtype === 'compact_boundary'
              && frame.session_id === nativeSessionId
              && (frame.compact_metadata as { trigger?: string } | undefined)?.trigger === 'manual') compact.boundary = true
            if (compact && frame && nativeSessionId && claudeCompactionResultMatches(frame, nativeSessionId, compact.promptUuid)) {
              await saveClaudeCompactionResult({ ...options.scope, nativeSessionId }, compact.promptUuid,
                frame.is_error === true ? 'failed' : compact.boundary ? 'completed' : 'no-op')
              compact = undefined
            }
            const observation = await observeResponse(raw)
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
            await outputQueue.offer({ raw, ...(observation ? { observation } : {}) })
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
      queryDispatched ||= client?.requiresRuntimeClosure?.() ?? false
      await session.close()
      throw error
    }
  }
  return runner
}
