import { ListOperatorConversationSummariesResponseSchema } from '@graphql/contracts'
import { apiClient, type RequestOptions } from './client'

/** Status-only polling; all authentication/cancellation still uses the shared HTTP boundary. */
export function listOperatorConversationSummaries(options?: RequestOptions) {
  return apiClient.request('/api/operator/conversations/summaries', ListOperatorConversationSummariesResponseSchema, options)
}
