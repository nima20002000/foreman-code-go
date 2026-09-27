import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useInfiniteQuery, useIsMutating, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
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
import { readEarlierChatHistory } from './historyReadback'
import { claimDraftReadback, receiptForCommand } from './receiptReadback'
import { acceptAgentChatState, agentChatContextKey, approvalReplyAvailable, intentUnavailable, stateBelongsToContext } from './model'

import { compactAgentChatResult, currentCommandReceipt, retireAgentChatAcknowledgements, type AgentChatCommand as Command, type AgentChatCommandResult as Result, type AgentChatCommandRecord } from './commandRecords'
export type { AgentChatCommandRecord } from './commandRecords'

function reconcileDraftReadback(state: AgentChatState | undefined, commands: AgentChatCommandRecord[], draftKey: string) {
  let reconciled = false
  for (const { command } of commands) {
    if (claimDraftReadback(command, receiptForCommand(state, command)) && command?.kind === 'send') {
      useConversationDraftStore.getState().clearDraft(draftKey, command.input.content)
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

export function useAgentChat(context: AgentChatContext) {
  const client = useQueryClient(), generation = sessionGeneration(), draftKey = agentChatContextKey(context)
  const key = useMemo(() => agentChatStateKey(context, generation), [draftKey, generation]) // eslint-disable-line react-hooks/exhaustive-deps
  const commandKey = useMemo(() => ['agent-chat', generation, draftKey, 'command'] as const, [draftKey, generation])
  const online = useSyncExternalStore(subscribeNetwork, isOnline, () => true)
  const access = useBrowserAccessQuery()
  const permits = (action: ManagementAction) => !sessionIsSwitching() && generation === sessionGeneration()
    && !access.isError && !!access.data && Date.parse(access.data.principal.expiresAt) > Date.now()
    && canUseBoardAction(access.data.principal.grants, action, context)
  const canRead = permits('agent_chat:read')
  const commands = useMutationState<AgentChatCommandRecord>({ filters: { mutationKey: commandKey, exact: true }, select: (mutation) => ({
    command: mutation.state.variables as Command | undefined, result: mutation.state.data as Result | undefined,
    error: mutation.state.error, status: mutation.state.status, submittedAt: mutation.state.submittedAt,
  }) })
  const latestCommand = commands.at(-1)
  const pending = useIsMutating({ mutationKey: commandKey, exact: true }) > 0
  const [localError, setLocalError] = useState<string>()
  const [connection, setConnection] = useState<AgentChatConnection>('connecting')
  const query = useQuery({ queryKey: key, enabled: canRead, retry: false, staleTime: 0, refetchInterval: 5_000,
    queryFn: async ({ signal }) => {
      const state = await agentChatApi.read(context, { signal })
      if (!stateBelongsToContext(state, context)) throw new ApiError({ code: 'AGENT_CHAT_CONTEXT_STALE', message: 'Chat returned a different selection. Refresh before sending.' }, 409)
      return state
    },
    structuralSharing: (previous, incoming) => acceptAgentChatState(previous as AgentChatState | undefined, incoming as AgentChatState),
  })
  const historyId = query.data?.conversation?.id
  const history = useInfiniteQuery({ queryKey: ['agent-chat', generation, context, historyId, 'history'],
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await readEarlierChatHistory((before) => agentChatApi.history(context.workspaceId, historyId!, before, { signal }),
          pageParam, query.data?.messages[0]?.id)
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
  const state = canRead && !denial && query.data && stateBelongsToContext(query.data, context) ? query.data : undefined
  const currentReceipt = latestCommand?.result
    ? currentCommandReceipt(latestCommand.result, state)
    : receiptForCommand(state, latestCommand?.command)
  const latestReceipt = currentReceipt ?? latestCommand?.result?.turn
  useEffect(() => {
    if (generation === sessionGeneration() && !sessionIsSwitching() && reconcileDraftReadback(state, commands, draftKey)) setLocalError(undefined)
  }, [state, commands, draftKey, generation])
  useEffect(() => { retireAgentChatAcknowledgements(client) }, [client, state])
  const accept = useCallback((incoming: AgentChatState) => {
    assertSession(generation)
    if (sessionIsSwitching() || !stateBelongsToContext(incoming, context)) return
    const historyRead = client.getQueryState(['agent-chat', generation, incoming.context, incoming.conversation?.id, 'history'])
    // A late SSE/command snapshot cannot undo a known denial; require a fresh state GET.
    if (historyRead && isAuthAccessError(historyRead.error) && historyRead.errorUpdatedAt >= (client.getQueryState(key)?.dataUpdatedAt ?? 0)) return
    client.setQueryData<AgentChatState>(key, (previous) => acceptAgentChatState(previous, incoming))
  }, [client, generation, key, draftKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false }).catch(() => undefined)
  }, [client, key])
  const conversationId = state?.conversation?.id
  useEffect(() => {
    if (!conversationId || !canRead || denial) return
    let timer: ReturnType<typeof setTimeout> | undefined, reading = false, dirty = false, disposed = false
    // Coalesce opaque delta events. An event during a read schedules a trailing read; it cannot
    // disappear behind a deduplicated in-flight GET. No text is invented from part/native ids.
    const refetch = () => {
      dirty = true
      if (reading || timer || disposed) return
      timer = setTimeout(async () => {
        timer = undefined; reading = true; dirty = false
        try {
          await client.cancelQueries({ queryKey: key, exact: true })
          if (!disposed) await client.refetchQueries({ queryKey: key, exact: true })
        } catch { /* Query retains the read error; the next event/reconnect can refresh it. */ } finally { reading = false; if (dirty && !disposed) refetch() }
      }, 100)
    }
    const close = subscribeAgentChat(context.workspaceId, conversationId, {
      snapshot: (incoming) => { if (stateBelongsToContext(incoming, context)) accept(incoming); else refetch() },
      event: refetch, refetch, connection: setConnection,
    })
    return () => { disposed = true; clearTimeout(timer); close() }
  }, [client, key, context.workspaceId, draftKey, conversationId, canRead, denial, accept]) // eslint-disable-line react-hooks/exhaustive-deps

  const mutation = useMutation<Result, Error, Command>({ mutationKey: commandKey, retry: false, gcTime: Infinity,
    // Never park a write offline and send it later to a potentially changed native turn.
    networkMode: 'always',
    mutationFn: async (command) => {
      assertSession(generation)
      if (!isOnline()) throw new ApiError({ code: 'OFFLINE', message: 'You are offline. No request was sent.' }, 400)
      const workspaceId = context.workspaceId
      const result = command.kind === 'send' ? await agentChatApi.send(workspaceId, command.input)
        : command.kind === 'stop' ? await agentChatApi.interrupt(workspaceId, command.conversationId,
          { requestId: command.requestId, ...(command.expectedNativeTurnId ? { expectedNativeTurnId: command.expectedNativeTurnId } : {}) })
          : command.kind === 'cancel' ? await agentChatApi.cancelQueued(workspaceId, command.conversationId, command.turnRequestId, { requestId: command.requestId })
            : await agentChatApi.respond(workspaceId, command.conversationId, { requestId: command.requestId, nativeRequestId: command.nativeRequestId, optionId: command.optionId })
      if (!stateBelongsToContext(result.state, context)
        || command.kind !== 'send' && result.state.conversation?.id !== command.conversationId
        || command.kind === 'send' && (!('turn' in result) || (result as { turn: { requestId: string } }).turn.requestId !== command.input.requestId
          || command.input.expectedConversationId !== null && result.state.conversation?.id !== command.input.expectedConversationId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The response did not confirm this command in this conversation.' })
      }
      if (generation === sessionGeneration() && !sessionIsSwitching()) accept(result.state)
      return compactAgentChatResult(result)
    },
    onSuccess: (result, command) => {
      if (generation !== sessionGeneration() || sessionIsSwitching()) return
      // State was accepted in mutationFn; the stored result is compact.
      if (command.kind === 'send' && claimDraftReadback(command, result.turn)) {
        setLocalError(undefined)
        useConversationDraftStore.getState().clearDraft(draftKey, command.input.content)
      }
      refresh()
    },
    onError: () => { if (generation === sessionGeneration() && !sessionIsSwitching()) refresh() },
  })
  const runCommand = (build: () => Command): boolean => {
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
    if (!online) return 'You are offline. Your draft is kept.'
    if (!permits(action)) return 'Your access does not allow this action for this Agent and Run.'
    if (!state || query.isError) return 'Refresh this conversation before sending a command.'
    if (state.availability.reason === 'run_active' || state.sessionState === 'unavailable') {
      return state.availability.message ?? 'This selection is read only.'
    }
    if (pending) return 'A command is being sent.'
    return undefined
  }
  const send = (content: string, intent: AgentChatIntent, clearDraft = true, allowNewMessage = false): boolean => {
    const text = content.trim()
    const reason = blocked('agent_chat:write') ?? (state ? intentUnavailable(state, intent) : undefined)
    // A completed send can clear the draft before React paints its empty value. Ignore an old
    // Enter/click handler in that gap; do not allocate another requestId for the cleared text.
    reconcileDraftReadback(client.getQueryData<AgentChatState>(key), commands, draftKey)
    if (clearDraft && (useConversationDraftStore.getState().drafts[draftKey] ?? '').trim() !== text) return false
    if (reason || !state || !text || text.length > 32_000) { setLocalError(reason ?? 'Write a message of up to 32,000 characters.'); return false }
    const unconfirmed = state.turns.some((turn) => turn.delivery === 'unknown' && state.messages.some((message) => message.id === turn.messageId && message.content.trim() === text))
      || commands.some((record) => {
        if (record.command?.kind !== 'send' || record.command.input.content !== text) return false
        const receipt = receiptForCommand(state, record.command) ?? (record.result && 'turn' in record.result ? record.result.turn : undefined)
        return receipt ? receipt.delivery === 'unknown' : record.status === 'error' && commandMayHaveBeenAccepted(record.error)
      })
    if (unconfirmed && !allowNewMessage) { setLocalError('Delivery is unknown. Use “Send again as new message” and review the warning.'); return false }
    return runCommand(() => {
      const target = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId,
        ...(context.runId ? { runId: context.runId } : {}) }
      return { kind: 'send', clearDraft, input: { requestId: `agent-chat-${crypto.randomUUID()}`, context: target, content: text, intent,
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
  return { state, query, history, access, canRead, denial, online, pending, connection, commands, latestCommand, latestReceipt, currentReceipt, localError, blocked,
    send, stop, cancelQueued, respond, refresh, draftKey }
}
