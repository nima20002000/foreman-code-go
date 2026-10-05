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
  const key = ['session-controls', generation, workspaceId ?? 'operator', conversationId, context, executionId]
  const query = useQuery({ queryKey: key, enabled: !!conversationId || !!context,
    queryFn: ({ signal }) => conversationId ? sessionControlsApi.read(conversationId, workspaceId, { signal })
      : sessionControlsApi.readContext(context!, executionId, { signal }),
    retry: false, refetchInterval: 3000 })
  const mutation = useMutation({ mutationKey: key, retry: false, networkMode: 'always',
    mutationFn: async (request: SessionControlRequest) => {
      assertSession(generation)
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
  const change = async (input: Change) => {
    if (client.getMutationCache().findAll({ mutationKey: key, exact: true }).some(entry => entry.state.status === 'pending')) throw new Error('A session control is still pending.')
    if (!query.data) throw new Error('Session controls are loading. Refresh their status before trying again.')
    return mutation.mutateAsync({ ...input, requestId: crypto.randomUUID(), expectedRevision: query.data.revision })
  }
  const command = async (content: string, draftKey: string) => {
    const parsed = parseSessionCommand(content)
    if (parsed.kind === 'invalid') throw new Error(parsed.message)
    if (parsed.kind !== 'compact' && parsed.kind !== 'mode') return false
    const state = await change(parsed)
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
