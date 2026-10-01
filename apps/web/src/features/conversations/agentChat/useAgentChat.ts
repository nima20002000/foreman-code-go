import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useInfiniteQuery, useIsMutating, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient, type MutationFilters } from '@tanstack/react-query'
import type { ManagementAction } from '@graphql/contracts/management'
import type { AgentChatContext, AgentChatIntent, AgentChatState } from '@graphql/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { ApiError } from '../../../shared/api/client'
import { subscribeAgentChat, type AgentChatConnection } from '../../../shared/api/agentChatStream'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../../shared/api/sessionBoundary'
import { useBrowserAccessQuery } from '../../../shared/api/settingsExperience'
import { isAuthAccessError } from '../../auth/accessError'
import { useProtectedAccessError } from '../../auth/useProtectedAccessError'
import { canUseBoardAction } from '../../workflow-board/permissions'
import { useConversationDraftStore } from '../conversationDraftStore'
import { messageAttachmentRefs, sameAttachmentRefs, type ChatAttachmentAttempt } from '../chatAttachmentAttempt'
import { selectedRunChatApi } from './selectedRunChatClient'
import { createChatVisit, selectedChatDraftKey, stateMatchesSelectedChat, type SelectedChatBinding } from './selectedRunChatModel'
import { readEarlierChatHistory } from './historyReadback'
import { claimDraftReadback, receiptForCommand } from './receiptReadback'
import { acceptAgentChatState, agentChatContextKey, approvalReplyAvailable, intentUnavailable, stateBelongsToContext } from './model'

import { agentChatReadbacksKey, compactAgentChatResult, confirmedCommandReceipt, currentCommandReceipt, rememberAgentChatReadback, retireAgentChatAcknowledgements, type AgentChatReadbacks, type AgentChatCommand as Command, type AgentChatCommandResult as Result, type AgentChatCommandRecord } from './commandRecords'
export type { AgentChatCommandRecord } from './commandRecords'

function reconcileDraftReadback(state: AgentChatState | undefined, commands: AgentChatCommandRecord[], draftKey: string, selected = false) {
  let reconciled = false
  for (const record of commands) {
    const { command } = record
    const acknowledgement = selected && record.result?.conversationId === state?.conversation?.id ? record.result?.turn : undefined
    if (claimDraftReadback(command, confirmedCommandReceipt(record, state) ?? receiptForCommand(state, command) ?? acknowledgement) && command?.kind === 'send') {
      useConversationDraftStore.getState().clearDraft(draftKey, command.input.content)
      command.attachmentAttempt?.acknowledge?.()
      reconciled = true
    }
  }
  return reconciled
}

// A synchronous admission latch, NOT a second copy of server/request state. It covers the gap
// before React renders mutation.isPending and survives closing/reopening a panel during a POST.
const locks = new WeakMap<QueryClient, Set<string>>()
function acquire(client: QueryClient, key: string): (() => void) | undefined {
  const keys = locks.get(client) ?? new Set<string>()
  locks.set(client, keys)
  if (keys.has(key)) return undefined
  keys.add(key)
  return () => { keys.delete(key) }
}
const subscribeNetwork = (notify: () => void) => {
  window.addEventListener('online', notify); window.addEventListener('offline', notify)
  return () => { window.removeEventListener('online', notify); window.removeEventListener('offline', notify) }
}
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine
export const agentChatStateKey = (context: AgentChatContext, generation = sessionGeneration()) => ['agent-chat', generation, agentChatContextKey(context), 'state'] as const

/** Network/invalid-success/5xx failures may have happened AFTER durable admission. No automatic retry. */
export function commandMayHaveBeenAccepted(error: unknown): boolean {
  return !ApiError.is(error) || error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE'
}

export function useAgentChat(context: AgentChatContext, selected?: SelectedChatBinding) {
  const client = useQueryClient(), generation = sessionGeneration()
  const draftKey = selected ? selectedChatDraftKey(selected.selection, context.agentId, selected.key?.conversationId ?? null) : agentChatContextKey(context)
  const creationDraftKey = selected ? selectedChatDraftKey(selected.selection, context.agentId, null) : draftKey
  const visit = useMemo(() => createChatVisit(() => selected?.isCurrent() ?? true), [selected])
  useEffect(() => visit.mount(), [visit])
  const isCurrent = useCallback(() => !selected || visit.isCurrent(), [selected, visit])
  const matches = useCallback((incoming: AgentChatState) => selected
    ? stateMatchesSelectedChat(incoming, context, selected) : stateBelongsToContext(incoming, context), [context, selected])
  const key = useMemo(() => selected
    ? ['agent-chat', generation, draftKey, 'state', selected.visitId] as const
    : agentChatStateKey(context, generation), [draftKey, generation, selected, context])
  const commandKey = useMemo(() => ['agent-chat', generation, draftKey, 'command'] as const, [draftKey, generation])
  // Keep the original creation mutation, not a copied receipt/request state. It may outlive
  // a lost first-send acknowledgement or a Run switch. Only this execution can claim it.
  const commandFilters = useMemo<MutationFilters>(() => selected ? { predicate: (mutation) => {
    const candidate = mutation.options.mutationKey
    if (candidate?.length !== 4 || candidate[0] !== 'agent-chat' || candidate[1] !== generation || candidate[3] !== 'command') return false
    if (candidate[2] === draftKey) return true
    const command = mutation.state.variables as Command | undefined, result = mutation.state.data as Result | undefined
    return candidate[2] === creationDraftKey && command?.kind === 'send' && command.input.expectedConversationId === null
      && (!result?.conversationId || result.conversationId === selected.key?.conversationId)
  } } : { mutationKey: commandKey, exact: true }, [selected, generation, draftKey, creationDraftKey, commandKey])
  const online = useSyncExternalStore(subscribeNetwork, isOnline, () => true)
  const access = useBrowserAccessQuery()
  const permits = (action: ManagementAction) => !sessionIsSwitching() && generation === sessionGeneration()
    && !access.isError && !!access.data && Date.parse(access.data.principal.expiresAt) > Date.now()
    && canUseBoardAction(access.data.principal.grants, action, context)
  const canRead = permits('agent_chat:read') && isCurrent()
  const readbacks = useQuery<AgentChatReadbacks>({ queryKey: agentChatReadbacksKey, enabled: false, gcTime: Infinity })
  const records = useMutationState<AgentChatCommandRecord & { mutationId: number }>({ filters: commandFilters, select: (mutation) => ({
    mutationId: mutation.mutationId, command: mutation.state.variables as Command | undefined, result: mutation.state.data as Result | undefined,
    error: mutation.state.error, status: mutation.state.status, submittedAt: mutation.state.submittedAt,
  }) })
  const commands = useMemo(() => records.map((record) => ({ ...record, readback: readbacks.data?.[record.mutationId] })), [records, readbacks.data])
  const latestCommand = commands.at(-1)
  const pending = useIsMutating(commandFilters) > 0
  const [localError, setLocalError] = useState<string>()
  const [connection, setConnection] = useState<AgentChatConnection>('connecting')
  const query = useQuery({ queryKey: key, enabled: canRead, retry: false, staleTime: 0, refetchInterval: 5_000, ...(selected ? { gcTime: 0 } : {}),
    queryFn: async ({ signal }) => {
      const current = visit.capture()
      if (selected && !current()) throw new DOMException('Selection changed', 'AbortError')
      const result = selected ? await selectedRunChatApi.read(selected.selection, { signal }) : undefined
      if (selected && (!current() || signal.aborted)) throw new DOMException('Selection changed', 'AbortError')
      if (result && result.kind !== 'selected') throw new ApiError({ code: 'SELECTED_CHAT_UNAVAILABLE',
        message: result.kind === 'unavailable' && result.reason === 'legacy_run' ? 'Snapshot unavailable' : 'Session unavailable' }, 409)
      const state = result?.kind === 'selected' ? result.state : await agentChatApi.read(context, { signal })
      signal.throwIfAborted()
      assertSession(generation)
      if (!matches(state)) throw new ApiError({ code: 'AGENT_CHAT_CONTEXT_STALE', message: 'Chat returned a different selection. Refresh before sending.' }, 409)
      return state
    },
    structuralSharing: (previous, incoming) => {
      const accepted = acceptAgentChatState(previous as AgentChatState | undefined, incoming as AgentChatState)
      if (generation === sessionGeneration() && !sessionIsSwitching() && isCurrent()) {
        rememberAgentChatReadback(client, key, accepted)
        if (selected) rememberAgentChatReadback(client, ['agent-chat', generation, creationDraftKey], accepted)
      }
      return accepted
    },
  })
  const historyId = query.data?.conversation?.id
  const historyKey = selected ? ['agent-chat', generation, draftKey, 'history', historyId, selected.visitId]
    : ['agent-chat', generation, context, historyId, 'history']
  const history = useInfiniteQuery({ queryKey: historyKey, ...(selected ? { gcTime: 0 } : {}),
    queryFn: async ({ pageParam, signal }) => {
      try {
        const current = visit.capture()
        if (selected && !current()) throw new DOMException('Selection changed', 'AbortError')
        const result = await readEarlierChatHistory(async (before) => {
          if (selected && !current()) throw new DOMException('Selection changed', 'AbortError')
          return agentChatApi.history(context.workspaceId, historyId!, before, { signal })
        }, pageParam, query.data?.messages[0]?.id)
        if (selected && (!current() || signal.aborted)) throw new DOMException('Selection changed', 'AbortError')
        return result
      } catch (error) {
        // A state GET started before a known denial cannot clear it with a stale response.
        if (isAuthAccessError(error)) await client.cancelQueries({ queryKey: key, exact: true })
        throw error
      }
    },
    initialPageParam: undefined as string | undefined, getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: false, retry: false,
  })
  const historyDenial = history.errorUpdatedAt >= query.dataUpdatedAt && isAuthAccessError(history.error) ? history.error : undefined
  const denial = useProtectedAccessError(query, historyDenial
    ?? (latestCommand && latestCommand.submittedAt > query.dataUpdatedAt ? latestCommand.error : undefined))
  const state = canRead && isCurrent() && !denial && !(selected && query.isError) && query.data && matches(query.data) ? query.data : undefined
  const currentReceipt = latestCommand?.result
    ? currentCommandReceipt(latestCommand.result, state)
    : receiptForCommand(state, latestCommand?.command)
  const confirmedReceipt = confirmedCommandReceipt(latestCommand, state)
  const latestReceipt = currentReceipt ?? latestCommand?.result?.turn ?? confirmedReceipt
  useEffect(() => {
    if (generation !== sessionGeneration() || sessionIsSwitching() || !isCurrent()) return
    // Settle the provisional draft BEFORE promoting its address. A later POST callback
    // is fenced by that promotion and cannot claim a readback against an empty old key.
    if (reconcileDraftReadback(state, commands, draftKey, !!selected)) setLocalError(undefined)
    if (selected && !selected.key && state?.conversation) selected.onConversation(state)
  }, [state, commands, draftKey, generation, selected, isCurrent])
  useEffect(() => { retireAgentChatAcknowledgements(client) }, [client, state])
  const accept = useCallback((incoming: AgentChatState) => {
    assertSession(generation)
    if (sessionIsSwitching() || !isCurrent() || !matches(incoming)) return
    const historyRead = client.getQueryState(selected
      ? ['agent-chat', generation, draftKey, 'history', incoming.conversation?.id, selected.visitId]
      : ['agent-chat', generation, incoming.context, incoming.conversation?.id, 'history'])
    // A late SSE/command snapshot cannot undo a known denial; require a fresh state GET.
    if (historyRead && isAuthAccessError(historyRead.error) && historyRead.errorUpdatedAt >= (client.getQueryState(key)?.dataUpdatedAt ?? 0)) return
    client.setQueryData<AgentChatState>(key, (previous) => acceptAgentChatState(previous, incoming))
  }, [client, generation, key, draftKey, selected, isCurrent, matches])
  const refresh = useCallback(() => {
    if (!isCurrent()) return
    void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false }).catch(() => undefined)
  }, [client, key, isCurrent])
  // A command begun on an earlier visit can settle while this visit is mounted.
  // Its receipt is never treated as a snapshot: request a fresh exact-selection GET.
  const settledCommand = latestCommand && latestCommand.status !== 'pending'
    ? JSON.stringify([latestCommand.submittedAt, latestCommand.status, latestCommand.result?.conversationId]) : undefined
  useEffect(() => { if (selected && settledCommand) refresh() }, [selected, settledCommand, refresh])
  const conversationId = state?.conversation?.id
  useEffect(() => {
    if (!conversationId || !canRead || denial || !isCurrent()) return
    let timer: ReturnType<typeof setTimeout> | undefined, reading = false, dirty = false, disposed = false
    const current = visit.capture()
    // Coalesce opaque delta events. An event during a read schedules a trailing read; it cannot
    // disappear behind a deduplicated in-flight GET. No text is invented from part/native ids.
    const refetch = () => {
      if (disposed || selected && !current()) return
      dirty = true
      if (reading || timer || disposed) return
      timer = setTimeout(async () => {
        timer = undefined; reading = true; dirty = false
        try {
          await client.cancelQueries({ queryKey: key, exact: true })
          if (!disposed && (!selected || current())) await client.refetchQueries({ queryKey: key, exact: true })
        } catch { /* Query retains the read error; the next event/reconnect can refresh it. */ } finally { reading = false; if (dirty && !disposed) refetch() }
      }, 100)
    }
    const close = subscribeAgentChat(context.workspaceId, conversationId, {
      snapshot: (incoming) => {
        if (disposed || selected && !current()) return
        if (matches(incoming)) accept(incoming)
        else if (!selected) refetch()
      },
      event: refetch, refetch, connection: (next) => { if (!disposed && (!selected || current())) setConnection(next) },
    })
    return () => { disposed = true; clearTimeout(timer); close() }
  }, [client, key, context.workspaceId, draftKey, conversationId, canRead, denial, accept, matches, selected, visit, isCurrent])

  const mutation = useMutation<Result, Error, Command>({ mutationKey: commandKey, retry: false, gcTime: Infinity,
    // Never park a write offline and send it later to a potentially changed native turn.
    networkMode: 'always',
    mutationFn: async (command) => {
      assertSession(generation)
      const current = visit.capture()
      if (selected && !current()) throw new ApiError({ code: 'AGENT_CHAT_CONTEXT_STALE', message: 'Selection changed. No request was sent.' }, 409)
      if (selected && command.kind !== 'send' && (!selected.key || command.conversationId !== selected.key.conversationId)) {
        throw new ApiError({ code: 'AGENT_CHAT_CONTEXT_STALE', message: 'Conversation changed. No request was sent.' }, 409)
      }
      if (!isOnline()) throw new ApiError({ code: 'OFFLINE', message: 'You are offline. No request was sent.' }, 400)
      const workspaceId = context.workspaceId
      const result = command.kind === 'send' ? selected
        ? await selectedRunChatApi.send(selected.selection, command.input) : await agentChatApi.send(workspaceId, command.input)
        : command.kind === 'stop' ? selected?.key
          ? await selectedRunChatApi.interrupt(selected.key, { requestId: command.requestId,
            ...(command.expectedNativeTurnId ? { expectedNativeTurnId: command.expectedNativeTurnId } : {}) })
          : await agentChatApi.interrupt(workspaceId, command.conversationId,
            { requestId: command.requestId, ...(command.expectedNativeTurnId ? { expectedNativeTurnId: command.expectedNativeTurnId } : {}) })
          : command.kind === 'cancel' ? await agentChatApi.cancelQueued(workspaceId, command.conversationId, command.turnRequestId, { requestId: command.requestId })
            : await agentChatApi.respond(workspaceId, command.conversationId, { requestId: command.requestId, nativeRequestId: command.nativeRequestId, optionId: command.optionId })
      if (!matches(result.state)
        || command.kind !== 'send' && result.state.conversation?.id !== command.conversationId
        || command.kind === 'send' && (!('turn' in result) || (result as { turn: { requestId: string } }).turn.requestId !== command.input.requestId
          || command.input.expectedConversationId !== null && result.state.conversation?.id !== command.input.expectedConversationId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The response did not confirm this command in this conversation.' })
      }
      if (generation === sessionGeneration() && !sessionIsSwitching() && (!selected || current())) accept(result.state)
      return compactAgentChatResult(result)
    },
    onSuccess: (result, command) => {
      if (generation !== sessionGeneration() || sessionIsSwitching() || !isCurrent()) return
      // State was accepted in mutationFn; the stored result is compact.
      if (command.kind === 'send' && claimDraftReadback(command, result.turn)) {
        setLocalError(undefined)
        useConversationDraftStore.getState().clearDraft(draftKey, command.input.content)
        command.attachmentAttempt?.acknowledge?.()
      }
      refresh()
    },
    onError: () => { if (generation === sessionGeneration() && !sessionIsSwitching() && isCurrent()) refresh() },
  })
  const runCommand = (build: () => Command): boolean => {
    if (!isCurrent()) return false
    const release = acquire(client, JSON.stringify(commandKey))
    if (!release) return false
    setLocalError(undefined)
    try {
      // Allocate exactly one requestId AFTER synchronous admission, not on each keystroke/click.
      void mutation.mutateAsync(build()).catch(() => undefined).finally(() => { release(); retireAgentChatAcknowledgements(client) })
      return true
    } catch (error) { release(); setLocalError(error instanceof Error ? error.message : 'The command could not be prepared.'); return false }
  }
  const blocked = (action: ManagementAction) => {
    if (!isCurrent()) return 'Selection changed.'
    if (!online) return 'You are offline. Your draft is kept.'
    if (!permits(action)) return 'Your access does not allow this action for this Agent and Run.'
    if (!state || query.isError) return 'Refresh this conversation before sending a command.'
    if (selected && !selected.key && (state.conversation || action !== 'agent_chat:write')) return 'Loading…'
    if (state.availability.reason === 'run_active' || state.sessionState === 'unavailable') {
      return state.availability.message ?? 'This selection is read only.'
    }
    if (pending) return 'A command is being sent.'
    return undefined
  }
  const send = (content: string, intent: AgentChatIntent, clearDraft = true, allowNewMessage = false, attachmentAttempt?: ChatAttachmentAttempt): boolean => {
    const text = content.trim()
    const attachments = attachmentAttempt?.attachments ?? []
    const reason = blocked('agent_chat:write') ?? (state ? intentUnavailable(state, intent) : undefined)
    // A completed send can clear the draft before React paints its empty value. Ignore an old
    // Enter/click handler in that gap; do not allocate another requestId for the cleared text.
    if (!isCurrent()) return false
    reconcileDraftReadback(client.getQueryData<AgentChatState>(key), commands, draftKey, !!selected)
    if (clearDraft && (useConversationDraftStore.getState().drafts[draftKey] ?? '').trim() !== text) return false
    if (clearDraft && attachmentAttempt?.isCurrent && !attachmentAttempt.isCurrent()) return false
    if (reason || !state || (!text && !attachments.length) || text.length > 32_000 || attachments.length > 0 && !state.conversation) { setLocalError(reason ?? 'Write a message of up to 32,000 characters.'); return false }
    const unconfirmed = state.turns.some((turn) => turn.delivery === 'unknown' && state.messages.some((message) => message.id === turn.messageId && message.content.trim() === text && sameAttachmentRefs(messageAttachmentRefs(message), attachments)))
      || commands.some((record) => {
        if (record.command?.kind !== 'send' || record.command.input.content !== text || !sameAttachmentRefs(record.command.input.attachments, attachments)) return false
        const receipt = confirmedCommandReceipt(record, state) ?? receiptForCommand(state, record.command) ?? (record.result && 'turn' in record.result ? record.result.turn : undefined)
        return receipt ? receipt.delivery === 'unknown' : record.status === 'error' && commandMayHaveBeenAccepted(record.error)
      })
    if (unconfirmed && !allowNewMessage) { setLocalError('Delivery is unknown. Use “Send again as new message” and review the warning.'); return false }
    return runCommand(() => {
      const target = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId,
        ...(context.runId ? { runId: context.runId } : {}) }
      return { kind: 'send', clearDraft, attachmentAttempt, input: { requestId: `agent-chat-${crypto.randomUUID()}`, context: target, content: text, intent,
        ...(attachments.length ? { attachments: attachments.map((pin) => ({ ...pin })) } : {}),
        expectedConversationId: state.conversation?.id ?? null,
        ...(intent !== 'next_turn' && state.activeTurn?.nativeTurnId ? { expectedNativeTurnId: state.activeTurn.nativeTurnId } : {}) } }
    })
  }
  const stop = () => {
    const reason = blocked('agent_chat:cancel')
    if (reason || !state?.conversation || !state.capabilities.interruptAndSend || state.availability.reason === 'run_active') return
    runCommand(() => ({ kind: 'stop', conversationId: state.conversation!.id, requestId: `agent-chat-stop-${crypto.randomUUID()}`,
      ...(state.activeTurn?.nativeTurnId ? { expectedNativeTurnId: state.activeTurn.nativeTurnId } : {}) }))
  }
  const cancelQueued = (turnRequestId: string) => {
    if (blocked('agent_chat:cancel') || !state?.conversation || state.turns.find((turn) => turn.requestId === turnRequestId)?.delivery !== 'queued') return
    runCommand(() => ({ kind: 'cancel', conversationId: state.conversation!.id, requestId: `agent-chat-cancel-${crypto.randomUUID()}`, turnRequestId }))
  }
  const respond = (optionId: string) => {
    if (blocked('agent_chat:respond') || !state?.conversation || !approvalReplyAvailable(state)
      || !state.pendingInteraction?.responseOptions.some((option) => option.optionId === optionId)) return
    runCommand(() => ({ kind: 'respond', conversationId: state.conversation!.id, requestId: `agent-chat-response-${crypto.randomUUID()}`,
      nativeRequestId: state.pendingInteraction!.turn.nativeRequestId!, optionId }))
  }
  return { state, query, history, access, canRead, denial, online, pending, connection, commands, latestCommand, latestReceipt, currentReceipt, confirmedReceipt, localError, blocked,
    send, stop, cancelQueued, respond, refresh, draftKey }
}
