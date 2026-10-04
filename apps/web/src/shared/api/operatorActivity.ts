import { OperatorActivityPageSchema, OperatorActivityQuerySchema, type OperatorActivity, type OperatorActivityQuery } from '@foreman-code/contracts'
import { apiClient, type RequestOptions } from './client'

export function getOperatorActivity(conversationId: string, query: Partial<OperatorActivityQuery> = {}, options?: RequestOptions) {
  const input = OperatorActivityQuerySchema.parse(query)
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.before) params.set('before', input.before)
  return apiClient.request(`/api/operator/conversations/${encodeURIComponent(conversationId)}/activity?${params}`, OperatorActivityPageSchema, options)
}

/** Merge accepted server projections without letting late polls regress an item. */
export function mergeOperatorActivity(...sources: readonly (readonly OperatorActivity[])[]): OperatorActivity[] {
  const entries = new Map<string, OperatorActivity>()
  for (const source of sources) for (const entry of source) {
    const key = `${entry.requestId}:${entry.id}`
    const prior = entries.get(key)
    if (!prior || entry.revision > prior.revision) entries.set(key, entry)
  }
  return [...entries.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0)
}
