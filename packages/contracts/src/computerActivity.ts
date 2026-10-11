import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { HarnessExecutionStateSchema, IdSchema, TimestampSchema } from './index.js'
import { JobProcessStateSchema } from './jobs.js'

export const COMPUTER_ACTIVITY_LIMIT = 200
/** One short label for a computer everywhere it is listed. */
export function computerDisplayName(hostRef: { kind: 'main' } | { kind: 'device'; deviceId: string }) {
  return hostRef.kind === 'main' ? 'Main PC' : `Computer ${hostRef.deviceId.slice(0, 8)}`
}
export const ComputerJobActivitySchema = z.object({
  id: IdSchema,
  name: z.string(),
  workspaceId: IdSchema,
  workspaceName: z.string(),
  phase: JobProcessStateSchema.shape.phase.exclude(['queued', 'terminal']),
  startedAt: TimestampSchema.nullable(),
}).strict()
export const ComputerAgentActivitySchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  workflowId: IdSchema,
  workflowName: z.string(),
  runId: IdSchema,
  nodeId: IdSchema,
  agentName: z.string(),
  state: HarnessExecutionStateSchema.exclude(['queued', 'completed']),
}).strict()
export const ComputerActivitySchema = z.object({
  target: DeviceProvisioningTargetSchema,
  name: z.string(),
  online: z.boolean(),
  jobs: z.array(ComputerJobActivitySchema).max(COMPUTER_ACTIVITY_LIMIT),
  agents: z.array(ComputerAgentActivitySchema).max(COMPUTER_ACTIVITY_LIMIT),
}).strict()
/** A cloud CI service Main can hand CI runs to: its machines exist only while a run uses them. */
export const CloudCiActivitySchema = z.object({
  provider: z.enum(['github', 'circleci']),
  name: z.string(),
  /** Main's login for the service works, so runs can start there. */
  ready: z.boolean(),
  /** Machines the service runs at once for Main. */
  slots: z.number().int().positive(),
  /** CI runs using one of its machines now. */
  running: z.number().int().nonnegative(),
}).strict()
export const ComputerActivityListSchema = z.object({
  mainId: z.uuid(),
  computers: z.array(ComputerActivitySchema).max(101),
  /** Cloud CI services that are ready or running work. */
  cloud: z.array(CloudCiActivitySchema).max(8),
  truncated: z.boolean(),
  /** Only global Jobs and Runs readers can infer that a computer has no activity. */
  activityComplete: z.boolean(),
}).strict()
export type ComputerJobActivity = z.infer<typeof ComputerJobActivitySchema>
export type ComputerAgentActivity = z.infer<typeof ComputerAgentActivitySchema>
export type ComputerActivity = z.infer<typeof ComputerActivitySchema>
export type CloudCiActivity = z.infer<typeof CloudCiActivitySchema>
export type ComputerActivityList = z.infer<typeof ComputerActivityListSchema>
