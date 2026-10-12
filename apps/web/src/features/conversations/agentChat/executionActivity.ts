import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentChatContext, AgentChatExecutionActivityPage, AgentChatExecutionItem, AgentChatExecutionSummary,
} from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { agentChatContextKey } from './model'

/** Accumulated live execution activity. Server pages are merged into this one Query cache entry. */
export interface ExecutionActivityFeed {
  executions: AgentChatExecutionSummary[]
  hasEarlierExecutions: boolean
  items: AgentChatExecutionItem[]
  cursor?: string
  hasMoreChanges: boolean
}

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'interrupted'])
export const executionIsLive = (execution: AgentChatExecutionSummary) => !TERMINAL.has(execution.state)
const itemKey = (item: AgentChatExecutionItem) => JSON.stringify([item.executionId, item.id])

/** Snapshot pages replace; change, earlier and item pages upsert by entry identity and never regress a revision. */
export function mergeExecutionActivity(previous: ExecutionActivityFeed | undefined, page: AgentChatExecutionActivityPage): ExecutionActivityFeed {
  const earlier = new Map(previous?.executions.map((execution) => [execution.executionId, execution.hasEarlierItems]))
  const executions = page.executions.map((execution) => {
    const hasEarlierItems = execution.hasEarlierItems ?? (page.mode === 'snapshot' ? undefined : earlier.get(execution.executionId))
    return { ...execution, ...(hasEarlierItems !== undefined ? { hasEarlierItems } : {}) }
  })
  const order = new Map(executions.map((execution, index) => [execution.executionId, index]))
  const items = new Map<string, AgentChatExecutionItem>()
  if (page.mode !== 'snapshot') for (const item of previous?.items ?? []) items.set(itemKey(item), item)
  for (const item of page.items) {
    const existing = items.get(itemKey(item))
    if (!existing || BigInt(item.revision) >= BigInt(existing.revision)) items.set(itemKey(item), item)
  }
  const sorted = [...items.values()].filter((item) => order.has(item.executionId)).sort((a, b) =>
    order.get(a.executionId)! - order.get(b.executionId)! || Number(BigInt(a.sequence) - BigInt(b.sequence)))
  return { executions, hasEarlierExecutions: page.hasEarlierExecutions, items: sorted,
    ...(page.cursor !== undefined ? { cursor: page.cursor } : previous?.cursor !== undefined ? { cursor: previous.cursor } : {}),
    hasMoreChanges: page.cursor !== undefined ? page.hasMoreChanges : previous?.hasMoreChanges ?? false }
}

/** Polls about once a second while an execution works; slower once every execution has finished. */
export function useExecutionActivity(context: AgentChatContext) {
  const client = useQueryClient()
  const key = useMemo(() => ['agent-chat', sessionGeneration(), agentChatContextKey(context), 'execution-activity'] as const, [context])
  const query = useQuery({
    queryKey: key, enabled: !!context.runId, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => {
      const cursor = client.getQueryData<ExecutionActivityFeed>(key)?.cursor
      const page = await agentChatApi.executionActivity(context, cursor ? { cursor } : {}, { signal })
      // Merge into the latest cache, which earlier-page and expand reads may have changed meanwhile.
      return mergeExecutionActivity(client.getQueryData<ExecutionActivityFeed>(key), page)
    },
    refetchInterval: (current) => {
      const data = current.state.data
      if (data?.hasMoreChanges) return 100
      return !data || data.executions.some(executionIsLive) ? 1_000 : 10_000
    },
  })
  const read = useCallback(async (page: { executionId: string; before?: string; itemId?: string }) => {
    const result = await agentChatApi.executionActivity(context, page)
    client.setQueryData<ExecutionActivityFeed>(key, (previous) => mergeExecutionActivity(previous, result))
  }, [client, context, key])
  return {
    query,
    loadEarlier: (executionId: string) => {
      const first = query.data?.items.find((item) => item.executionId === executionId)
      return read({ executionId, ...(first ? { before: first.sequence } : {}) })
    },
    expand: (executionId: string, itemId: string) => read({ executionId, itemId }),
  }
}
