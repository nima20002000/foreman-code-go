import { z } from 'zod'
import { HarnessSettingsSearchSchema } from '@foreman-code/contracts/management'
import { AccountProviderSchema, ProviderAccountIdSchema } from '@foreman-code/contracts/provider-accounts'

export const ProviderAccountsSettingsSearchSchema = HarnessSettingsSearchSchema.extend({
  accountProvider: AccountProviderSchema.optional(),
  accountId: ProviderAccountIdSchema.optional(),
  operationId: z.uuid().optional(),
})
