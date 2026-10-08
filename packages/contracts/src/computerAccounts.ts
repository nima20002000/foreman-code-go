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
  /** Continue after this paired device; Main appears only on the first page. */
  nextCursor: z.uuid().nullable().optional(),
}).strict()
export const ComputerAccountsListInputSchema = z.object({
  refresh: z.boolean().optional(),
  cursor: z.uuid().optional(),
}).strict()
export type ComputerAccountTool = z.infer<typeof ComputerAccountToolSchema>
export type ComputerAccount = z.infer<typeof ComputerAccountSchema>
export type ComputerAccounts = z.infer<typeof ComputerAccountsSchema>
export type ComputerAccountsList = z.infer<typeof ComputerAccountsListSchema>

export const COMPUTER_GITHUB_NAMESPACE = 'computer-github-v1'
/** Device-code sign-in to github.com with the GitHub CLI on one computer. The token never leaves that computer. */
export const GitHubLoginRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('login-start') }).strict(),
  z.object({ operation: z.literal('login-status'), loginId: z.uuid() }).strict(),
  z.object({ operation: z.literal('logout') }).strict(),
  z.object({ operation: z.literal('setup-git'), loginId: z.uuid() }).strict(),
])
export const GitHubLoginStateSchema = z.object({
  loginId: z.uuid().nullable(),
  state: z.enum(['waiting', 'signed-in', 'signed-out', 'git-setup-failed', 'failed', 'expired']),
  code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/).nullable(),
  verificationUrl: z.url().nullable(),
  expiresAt: z.string().datetime().nullable(),
  account: z.string().max(320).nullable(),
  message: z.string().max(500).nullable(),
}).strict()
export const ComputerGitHubInputSchema = z.object({ target: DeviceProvisioningTargetSchema }).strict()
export const ComputerGitHubStatusInputSchema = ComputerGitHubInputSchema.extend({ loginId: z.uuid() }).strict()
export type GitHubLoginRequest = z.infer<typeof GitHubLoginRequestSchema>
export type GitHubLoginState = z.infer<typeof GitHubLoginStateSchema>

export const COMPUTER_DRIVE_NAMESPACE = 'computer-drive-v1'
/** The rclone remote and user service the app manages on each computer. */
export const DRIVE_REMOTE = 'foreman-drive'
export const DRIVE_MOUNT_DIRECTORY = 'Foreman Code Drive'
/** The one Drive folder the app's remote is rooted at; the mount shows only this folder. */
export const DRIVE_APP_FOLDER = 'Foreman Code'
/** Requests Main sends to one computer. The OAuth token is written to that computer's rclone config and never stored by Main. */
export const DriveComputerRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('install') }).strict(),
  z.object({ operation: z.literal('connect'), token: z.string().min(2).max(8192) }).strict(),
  z.object({ operation: z.literal('disconnect') }).strict(),
])
export const DriveComputerStateSchema = z.object({
  installed: z.boolean(), connected: z.boolean(), account: z.string().max(320).nullable(),
  mountPath: z.string().startsWith('/').max(1024).nullable(), mounted: z.boolean(), message: z.string().max(500).nullable(),
}).strict()
export const DriveLoginStateSchema = z.object({
  loginId: z.uuid().nullable(),
  state: z.enum(['waiting', 'connecting', 'connected', 'disconnected', 'failed', 'expired']),
  /** Google sign-in through rclone on Main: open it in a browser on Main. */
  authorizationUrl: z.url().nullable(),
  expiresAt: z.string().datetime().nullable(),
  account: z.string().max(320).nullable(),
  mountPath: z.string().max(1024).nullable(),
  message: z.string().max(500).nullable(),
}).strict()
export const ComputerDriveInputSchema = ComputerGitHubInputSchema
export const ComputerDriveStatusInputSchema = ComputerGitHubStatusInputSchema
export type DriveComputerRequest = z.infer<typeof DriveComputerRequestSchema>
export type DriveComputerState = z.infer<typeof DriveComputerStateSchema>
export type DriveLoginState = z.infer<typeof DriveLoginStateSchema>
