import { z } from 'zod'
import {
  ProviderAccountsSnapshotSchema, ProviderAccountUpdateResultSchema, ProviderAccountSchema,
  ProviderAccountCreateInputSchema, ProviderAccountRenameInputSchema, ProviderAccountDefaultInputSchema,
  ProviderAccountCommandInputSchema, ProviderAccountApiKeyInputSchema, ProviderAccountPageSchema,
  ProviderAccountListInputSchema, ProviderAccountModelsSchema,
  ProviderAccountAuthenticationPrepareInputSchema, ProviderAccountAuthenticationReadInputSchema,
  ProviderAccountAuthenticationCancelInputSchema, ProviderAccountAuthenticationResultSchema,
  ProviderAccountAuthenticationOperationSchema,
  type ProviderAccountCreateInput, type ProviderAccountRenameInput,
  type ProviderAccountCommandInput, type ProviderAccountApiKeyInput,
} from '@foreman-code/contracts/provider-accounts'
import { apiClient, type RequestOptions } from '../../shared/api/client'

const root = '/api/provider-accounts'
export type ProviderAccountAction = 'default' | 'login' | 'logout' | 'refresh' | 'remove'
export type ProviderAccountPrepareInput = z.input<typeof ProviderAccountAuthenticationPrepareInputSchema>
export type ProviderAccountCancelInput = z.input<typeof ProviderAccountAuthenticationCancelInputSchema>
export type ProviderAccountDefaultInput = z.input<typeof ProviderAccountDefaultInputSchema>

export const providerAccountsClient = {
  list(options?: RequestOptions) {
    return apiClient.request(root, ProviderAccountsSnapshotSchema, options)
  },
  page(input: z.input<typeof ProviderAccountListInputSchema>, options?: RequestOptions) {
    const parsed = ProviderAccountListInputSchema.parse(input)
    const search = new URLSearchParams({ limit: String(parsed.limit) })
    if (parsed.provider) search.set('provider', parsed.provider)
    if (parsed.cursor) search.set('cursor', parsed.cursor)
    return apiClient.request(`${root}/page?${search}`, ProviderAccountPageSchema, options)
  },
  get(accountId: string, options?: RequestOptions) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}`, ProviderAccountSchema, options)
  },
  models(accountId: string, options?: RequestOptions) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/models`, ProviderAccountModelsSchema, options)
  },
  prepare(accountId: string, input: ProviderAccountPrepareInput) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/authentication`,
      ProviderAccountAuthenticationResultSchema, {
        method: 'POST', body: ProviderAccountAuthenticationPrepareInputSchema.parse(input),
      })
  },
  authentication(input: z.input<typeof ProviderAccountAuthenticationReadInputSchema>, options?: RequestOptions) {
    return apiClient.request(`${root}/authentication/status`, ProviderAccountAuthenticationOperationSchema, {
      ...options, method: 'POST', body: ProviderAccountAuthenticationReadInputSchema.parse(input),
    })
  },
  cancel(input: ProviderAccountCancelInput) {
    return apiClient.request(`${root}/authentication/cancel`, ProviderAccountAuthenticationResultSchema, {
      method: 'POST', body: ProviderAccountAuthenticationCancelInputSchema.parse(input),
    })
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
  action(accountId: string, action: ProviderAccountAction, input: ProviderAccountCommandInput | ProviderAccountDefaultInput) {
    const schema = action === 'default' ? ProviderAccountDefaultInputSchema : ProviderAccountCommandInputSchema
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/${action}`, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: schema.parse(input),
    })
  },
  apiKey(accountId: string, input: ProviderAccountApiKeyInput) {
    return apiClient.request(`${root}/${encodeURIComponent(accountId)}/api-key`, ProviderAccountUpdateResultSchema, {
      method: 'POST', body: ProviderAccountApiKeyInputSchema.parse(input),
    })
  },
}
