import { useEffect } from 'react'
import { ApiError } from '../../../shared/api/client'
import { pendingControl, savePendingControl, recoverPendingControl, clearPendingControl, type PendingControl } from './controlRequest'
import type { AgentChatContext } from '@graphql/contracts/agent-chat'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseSessionCommand, type SessionControlRequest } from '@graphql/contracts'
import { sessionControlsApi } from '../../../shared/api/sessionControls'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversationDraftStore'

type Change = SessionControlRequest extends infer Request ? Request extends SessionControlRequest
  ? Omit<Request, 'requestId' | 'expectedRevision'> : never : never

export function useSessionControls(conversationId: string | undefined, workspaceId?: string, context?: AgentChatContext, executionId?: string) {
  const client = useQueryClient()
  const generation = sessionGeneration()
  const target = context ? [context.workspaceId, context.workflowId, context.workflowNodeId,
    context.agentId, context.runId ?? null] : conversationId
  const scope = JSON.stringify([workspaceId ?? 'operator', target, executionId ?? null])
  const key = ['session-controls', generation, workspaceId ?? 'operator', conversationId, context, executionId]
  const query = useQuery({ queryKey: key, enabled: !!conversationId || !!context,
    queryFn: ({ signal }) => conversationId ? sessionControlsApi.read(conversationId, workspaceId, { signal })
      : sessionControlsApi.readContext(context!, executionId, { signal }),
    retry: false, refetchInterval: 3000 })
  useEffect(() => {
    if (query.data) recoverPendingControl(scope, query.data)
  }, [scope, query.data])
  const mutation = useMutation({ mutationKey: key, retry: false, networkMode: 'always',
    mutationFn: async (control: PendingControl) => {
      const request = control.request
      assertSession(generation)
      savePendingControl(scope, control)
      if (!conversationId && !context) throw new Error('Select a conversation or workflow node first.')
      if (!navigator.onLine) throw new Error('You are offline. Your draft is kept.')
      const result = conversationId ? await sessionControlsApi.change(conversationId, request, workspaceId)
        : await sessionControlsApi.changeContext(context!, request, executionId)
      assertSession(generation)
      return result
    },
    onSuccess: state => { client.setQueryData(key, state); void client.invalidateQueries({ queryKey: ['agent-chat'] }) },
    onSettled: () => { void client.invalidateQueries({ queryKey: key }) },
  })
  const change = async (input: Change, draft?: { key: string; content: string }) => {
    if (client.getMutationCache().findAll({ mutationKey: key, exact: true }).some(entry => entry.state.status === 'pending')) throw new Error('A session control is still pending.')
    if (!query.data) throw new Error('Session controls are loading. Refresh their status before trying again.')
    const pending = pendingControl(scope)
    if (pending) {
      const original = Object.fromEntries(Object.entries(pending.request)
        .filter(([field]) => field !== 'requestId' && field !== 'expectedRevision'))
      if (JSON.stringify(original) !== JSON.stringify(input)) {
        throw new Error('Recover the previous session control before changing settings.')
      }
    }
    const control = pending ? { ...pending, ...(draft && !pending.draft ? { draft } : {}) } : { request: { ...input, requestId: crypto.randomUUID(),
      expectedRevision: query.data.revision }, ...(draft ? { draft } : {}) }
    try {
      const state = await mutation.mutateAsync(control)
      recoverPendingControl(scope, state)
      return state
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500
        && !error.code.endsWith('_UNCONFIRMED')) clearPendingControl(scope, control.request.requestId)
      throw error
    }
  }
  const command = async (content: string, draftKey: string) => {
    const parsed = parseSessionCommand(content)
    if (parsed.kind === 'invalid') throw new Error(parsed.message)
    if (parsed.kind !== 'compact' && parsed.kind !== 'mode') return false
    const state = await change(parsed, { key: draftKey, content })
    if (parsed.kind === 'compact' && state.compaction && ['accepted', 'running', 'uncertain'].includes(state.compaction.status)) {
      throw new Error(state.compaction.message)
    }
    if (parsed.kind === 'compact' && state.compaction?.status === 'failed') throw new Error(state.compaction.message)
    useConversationDraftStore.getState().clearDraft(draftKey, content)
    return true
  }
  return { state: query.data, conversationId, query, mutation, change, command }
}
export type ComposerSessionControls = ReturnType<typeof useSessionControls>
