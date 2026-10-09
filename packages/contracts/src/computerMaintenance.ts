import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { HarnessMcpArgumentSchema, HarnessMcpEndpointSchema } from './management/harnessSettings.js'

/** Device channel namespace: Main asks a paired computer for maintenance status and starts maintenance tasks. */
export const COMPUTER_MAINTENANCE_NAMESPACE = 'computer-maintenance-v1'

/** Harnesses kept installed and current on every computer: Codex and Claude. */
export const MaintainedHarnessSchema = z.enum(['codex', 'claude'])
export type MaintainedHarness = z.infer<typeof MaintainedHarnessSchema>

export const MaintenanceTaskKindSchema = z.enum(['update-harnesses', 'update-system', 'restart', 'sync-mcp', 'sync-plugins'])
export type MaintenanceTaskKind = z.infer<typeof MaintenanceTaskKindSchema>

/** A user-level MCP server definition. Secret values are never copied: only environment variable names and URLs. */
export const SyncedMcpServerSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), name: z.string().min(1).max(100), command: z.string().min(1).max(4096),
    args: z.array(HarnessMcpArgumentSchema).max(100), envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(100) }).strict(),
  z.object({ transport: z.literal('http'), name: z.string().min(1).max(100), url: HarnessMcpEndpointSchema,
    bearerTokenEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).nullable() }).strict(),
])
export type SyncedMcpServer = z.infer<typeof SyncedMcpServerSchema>

export const SyncedMarketplaceSchema = z.object({ name: z.string().regex(/^[^\s@]+$/u).max(100), source: z.string().min(1).max(500) }).strict()
export type SyncedMarketplace = z.infer<typeof SyncedMarketplaceSchema>

export const MaintenanceTaskStartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update-harnesses'), harnesses: z.array(MaintainedHarnessSchema).min(1).max(2) }).strict(),
  z.object({ kind: z.literal('update-system') }).strict(),
  z.object({ kind: z.literal('restart') }).strict(),
  z.object({ kind: z.literal('sync-mcp'), servers: z.object({ codex: z.array(SyncedMcpServerSchema).max(100),
    claude: z.array(SyncedMcpServerSchema).max(100) }).strict() }).strict(),
  z.object({ kind: z.literal('sync-plugins'), plugins: z.array(z.string().regex(/^[^\s@]+@[^\s@]+$/u)).max(200),
    /** Main's Git plugin marketplaces; a computer adds the ones it lacks before installing plugins from them. */
    marketplaces: z.array(SyncedMarketplaceSchema).max(50),
    claudePlugins: z.array(z.object({ pluginId: z.string().regex(/^[^\s@]+@[^\s@]+$/u), enabled: z.boolean() }).strict()).max(200),
    claudeMarketplaces: z.array(SyncedMarketplaceSchema).max(50) }).strict(),
])
export type MaintenanceTaskStart = z.infer<typeof MaintenanceTaskStartSchema>

export const MaintenanceRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('start'), task: MaintenanceTaskStartSchema }).strict(),
])
export type MaintenanceRequest = z.infer<typeof MaintenanceRequestSchema>

export const MaintenanceTaskSchema = z.object({
  id: z.uuid(),
  kind: MaintenanceTaskKindSchema,
  state: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  /** Short readable outcome, e.g. "Codex 0.161.0 → 0.162.0" or the failing step. */
  summary: z.string().max(2000),
  /** Last lines of the task output for diagnosis. */
  outputTail: z.string().max(8000),
}).strict()
export type MaintenanceTask = z.infer<typeof MaintenanceTaskSchema>

export const HarnessVersionSchema = z.object({
  harness: MaintainedHarnessSchema,
  installed: z.boolean(),
  version: z.string().max(100).nullable(),
  /** Latest published version, or null when it could not be checked. */
  latest: z.string().max(100).nullable(),
}).strict()

export const MaintenanceStatusSchema = z.object({
  harnesses: z.array(HarnessVersionSchema).max(2),
  system: z.object({
    /** Pending OS upgrades, including APT-held and phased updates; null when the count cannot be verified. */
    packageUpdates: z.number().int().nonnegative().nullable(),
    rebootRequired: z.boolean(),
    /** Passwordless sudo is available for OS updates and restarts. */
    sudo: z.boolean(),
    disk: z.object({ path: z.string(), freeBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative() }).strict().nullable(),
  }).strict(),
  tasks: z.array(MaintenanceTaskSchema).max(20),
  observedAt: z.string().datetime(),
}).strict()
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>

export const MaintenanceReplySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), status: MaintenanceStatusSchema }).strict(),
  z.object({ operation: z.literal('start'), task: MaintenanceTaskSchema }).strict(),
])

/** Main-side readback across computers. null status: the computer is offline or did not answer in time. */
export const ComputerMaintenanceListSchema = z.object({
  computers: z.array(z.object({ target: DeviceProvisioningTargetSchema, status: MaintenanceStatusSchema.nullable() }).strict()).max(101),
}).strict()
export type ComputerMaintenanceList = z.infer<typeof ComputerMaintenanceListSchema>

/** Start one maintenance task on the selected computers (all paired computers and Main when omitted). */
export const ComputerMaintenanceStartInputSchema = z.object({
  commandId: z.uuid(),
  task: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('update-harnesses'), harnesses: z.array(MaintainedHarnessSchema).min(1).max(2) }).strict(),
    z.object({ kind: z.literal('update-system') }).strict(),
    z.object({ kind: z.literal('restart') }).strict(),
    z.object({ kind: z.literal('sync-mcp') }).strict(),
    z.object({ kind: z.literal('sync-plugins') }).strict(),
  ]),
  targets: z.array(DeviceProvisioningTargetSchema).min(1).max(101).optional(),
}).strict()
export type ComputerMaintenanceStartInput = z.infer<typeof ComputerMaintenanceStartInputSchema>

export const ComputerMaintenanceStartResultSchema = z.object({
  computers: z.array(z.object({ target: DeviceProvisioningTargetSchema, task: MaintenanceTaskSchema.nullable(),
    error: z.string().max(2000).nullable() }).strict()).max(101),
}).strict()
export type ComputerMaintenanceStartResult = z.infer<typeof ComputerMaintenanceStartResultSchema>
