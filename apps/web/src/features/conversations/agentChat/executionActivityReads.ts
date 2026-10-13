import { useEffect, useRef } from 'react'
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import type { mergeExecutionActivity, ExecutionActivityFeed } from './executionActivity'

export type ActivityRead = { executionId: string; before?: string; itemId?: string }
interface ReadRequest {
  page: ActivityRead
  context: AgentChatContext
  key: readonly unknown[]
  generation: number
  historyRequest?: number
  operation: string
  identity: string
}
const operationKey = (page: ActivityRead) => JSON.stringify([page.executionId, page.itemId ?? null])

/** Query mutations own each detail operation's pending/error state independently of live polling. */
export function useExecutionActivityReads(context: AgentChatContext, key: readonly unknown[],
  merge: typeof mergeExecutionActivity) {
  const client = useQueryClient()
  const historyRequest = useRef(0)
  const locks = useRef(new Set<string>())
  const mutationKey = [...key, 'detail']
  const identity = JSON.stringify(mutationKey)
  const selectedIdentity = useRef(identity)
  selectedIdentity.current = identity
  useEffect(() => () => {
    const cache = client.getMutationCache()
    for (const mutation of cache.getAll()) {
      if (JSON.stringify(mutation.options.mutationKey) === identity) cache.remove(mutation)
    }
  }, [client, identity])
  const states = useMutationState({ filters: { mutationKey, exact: true }, select: mutation => ({
    request: mutation.state.variables as ReadRequest | undefined,
    status: mutation.state.status,
  }) })
  const mutation = useMutation({
    mutationKey,
    mutationFn: async (request: ReadRequest) => {
      const result = await agentChatApi.executionActivity(request.context, request.page)
      assertSession(request.generation)
      return result
    },
    onSuccess: (result, request) => {
      if (request.identity !== selectedIdentity.current) return
      const active = request.historyRequest === undefined || request.historyRequest === historyRequest.current
      client.setQueryData<ExecutionActivityFeed>(request.key, previous =>
        merge(previous, result, active ? request.page : undefined))
    },
    onSettled: (_result, _error, request) => { locks.current.delete(request.operation) },
  })
  const read = (page: ActivityRead) => {
    const operation = JSON.stringify([key, operationKey(page)])
    if (locks.current.has(operation)) return
    locks.current.add(operation)
    mutation.mutate({ page, context, key, generation: sessionGeneration(), operation, identity,
      ...(page.itemId === undefined ? { historyRequest: ++historyRequest.current } : {}) })
  }
  const readState = (executionId: string, itemId?: string) => {
    const operation = operationKey({ executionId, ...(itemId !== undefined ? { itemId } : {}) })
    const state = [...states].reverse().find(entry => entry.request && operationKey(entry.request.page) === operation)
    return { pending: state?.status === 'pending', failed: state?.status === 'error' }
  }
  return { read, readState, abandonHistory: () => { historyRequest.current += 1 } }
}
