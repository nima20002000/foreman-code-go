import {
  ProviderAccountsSnapshotSchema, ProviderAccountUpdateResultSchema,
  ProviderAccountCreateInputSchema, ProviderAccountRenameInputSchema,
  ProviderAccountCommandInputSchema, ProviderAccountApiKeyInputSchema,
  type ProviderAccountCreateInput, type ProviderAccountRenameInput,
  type ProviderAccountCommandInput, type ProviderAccountApiKeyInput,
} from '@foreman-code/contracts/provider-accounts'
import { apiClient, type RequestOptions } from '../../shared/api/client'

const root = '/api/provider-accounts'
export type ProviderAccountAction = 'default' | 'login' | 'logout' | 'refresh'

export const providerAccountsClient = {
  list(options?: RequestOptions) {
    return apiClient.request(root, ProviderAccountsSnapshotSchema, options)
  },
  create(input: ProviderAccountCreateInput) {
    return apiClient.request(root, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: ProviderAccountCreateInputSchema.parse(input),
    })
  },
  rename(accountId: string, input: ProviderAccountRenameInput) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}`, ProviderAccountUpdateResultSchema, {
      method: 'PATCH', body: ProviderAccountRenameInputSchema.parse(input),
    })
  },
  action(accountId: string, action: ProviderAccountAction, input: ProviderAccountCommandInput) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/${action}`, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: ProviderAccountCommandInputSchema.parse(input),
    })
  },
  apiKey(accountId: string, input: ProviderAccountApiKeyInput) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/api-key`, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: ProviderAccountApiKeyInputSchema.parse(input),
    })
  },
}
