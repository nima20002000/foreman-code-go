import { z } from 'zod'

export const AccountProviderSchema = z.enum(['codex', 'claude'])
export const ProviderAccountAuthModeSchema = z.enum(['subscription', 'api-key'])
export const ProviderAccountStatusSchema = z.enum(['signed-out', 'signed-in', 'login-pending', 'unavailable'])
export const ProviderAccountIdSchema = z.string().uuid()
export const ProviderAccountSchema = z.object({
  id: ProviderAccountIdSchema,
  provider: AccountProviderSchema,
  name: z.string().trim().min(1).max(100),
  authMode: ProviderAccountAuthModeSchema,
  isDefault: z.boolean(),
  status: ProviderAccountStatusSchema,
  identity: z.string().max(200).nullable(),
  revision: z.number().int().nonnegative(),
}).strict()
export const ProviderAccountsSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  accounts: z.array(ProviderAccountSchema).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.accounts.map(account => account.id)).size !== value.accounts.length) {
    context.addIssue({ code: 'custom', path: ['accounts'], message: 'Account IDs must be unique.' })
  }
  for (const provider of AccountProviderSchema.options) {
    if (value.accounts.filter(account => account.provider === provider && account.isDefault).length > 1) {
      context.addIssue({ code: 'custom', path: ['accounts'], message: 'A provider may have only one default account.' })
    }
  }
})
export const ProviderAccountCommandInputSchema = z.object({
  commandId: z.string().trim().min(8).max(200),
  expectedRevision: z.number().int().nonnegative(),
}).strict()
export const ProviderAccountCreateInputSchema = ProviderAccountCommandInputSchema.extend({
  provider: AccountProviderSchema,
  name: ProviderAccountSchema.shape.name,
  authMode: ProviderAccountAuthModeSchema,
}).refine(value => value.provider !== 'codex' || value.authMode === 'subscription', {
  path: ['authMode'], message: 'Codex accounts use ChatGPT subscription sign-in.',
})
export const ProviderAccountRenameInputSchema = ProviderAccountCommandInputSchema.extend({
  name: ProviderAccountSchema.shape.name,
})
/** This input belongs only to the local human HTTP endpoint; it is never an MCP tool input. */
export const ProviderAccountApiKeyInputSchema = ProviderAccountCommandInputSchema.extend({
  apiKey: z.string().trim().min(20).max(4096).refine(value =>
    !/\s/.test(value) && !Array.from(value).some(character => character.charCodeAt(0) < 32)),
})
export const ProviderAccountUpdateResultSchema = z.object({
  value: ProviderAccountsSnapshotSchema,
  replayed: z.boolean(),
}).strict()
export const ProviderAccountToolCommandSchema = ProviderAccountCommandInputSchema.extend({
  accountId: ProviderAccountIdSchema,
})
export const ProviderAccountToolRenameSchema = ProviderAccountRenameInputSchema.extend({
  accountId: ProviderAccountIdSchema,
})
export const PROVIDER_ACCOUNT_TOOLS = [
  'provider_accounts_list', 'provider_account_create', 'provider_account_rename',
  'provider_account_default_set', 'provider_account_login', 'provider_account_logout', 'provider_account_refresh',
] as const

export type AccountProvider = z.infer<typeof AccountProviderSchema>
export type ProviderAccountAuthMode = z.infer<typeof ProviderAccountAuthModeSchema>
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>
export type ProviderAccountsSnapshot = z.infer<typeof ProviderAccountsSnapshotSchema>
export type ProviderAccountCommandInput = z.infer<typeof ProviderAccountCommandInputSchema>
export type ProviderAccountCreateInput = z.infer<typeof ProviderAccountCreateInputSchema>
export type ProviderAccountRenameInput = z.infer<typeof ProviderAccountRenameInputSchema>
export type ProviderAccountApiKeyInput = z.infer<typeof ProviderAccountApiKeyInputSchema>
