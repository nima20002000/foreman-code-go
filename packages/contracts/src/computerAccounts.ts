import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'

export const COMPUTER_ACCOUNTS_NAMESPACE = 'computer-accounts-v1'
export const ComputerAccountToolSchema = z.enum(['codex', 'claude', 'opencode', 'github', 'drive'])
/** Identity facts only: never tokens, keys or credential paths. */
export const ComputerAccountSchema = z.object({
  tool: ComputerAccountToolSchema,
  installed: z.boolean(),
  /** null when the tool is installed but its sign-in state could not be read. */
  signedIn: z.boolean().nullable(),
  account: z.string().max(320).nullable(),
  /** Short public facts such as sign-in method, provider names or a mount path. */
  details: z.array(z.string().max(200)).max(16),
}).strict()
export const ComputerAccountsSchema = z.object({
  accounts: z.array(ComputerAccountSchema).max(ComputerAccountToolSchema.options.length),
  observedAt: z.string().datetime(),
}).strict()
export const ComputerAccountsRequestSchema = z.object({ operation: z.literal('read') }).strict()
export const ComputerAccountsEntrySchema = z.object({
  target: DeviceProvisioningTargetSchema,
  /** null when the computer is offline or did not answer in time. */
  accounts: ComputerAccountsSchema.nullable(),
}).strict()
export const ComputerAccountsListSchema = z.object({
  computers: z.array(ComputerAccountsEntrySchema).max(101),
}).strict()
export type ComputerAccountTool = z.infer<typeof ComputerAccountToolSchema>
export type ComputerAccount = z.infer<typeof ComputerAccountSchema>
export type ComputerAccounts = z.infer<typeof ComputerAccountsSchema>
export type ComputerAccountsList = z.infer<typeof ComputerAccountsListSchema>
