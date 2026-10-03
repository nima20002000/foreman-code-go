import { z } from 'zod'

export const WORKER_EXECUTION_STARTUP_VARIABLE = 'GRAPHQL_LAPTOP_EXECUTION_ENABLED'

/** The Main deployment controls execution on connected Worker computers. */
export const WorkerExecutionSettingsSchema = z.object({
  enabled: z.boolean(),
  managedBy: z.literal('startup'),
}).strict()

export type WorkerExecutionSettings = z.infer<typeof WorkerExecutionSettingsSchema>

export const DEFAULT_WORKER_EXECUTION_SETTINGS: WorkerExecutionSettings = {
  enabled: false,
  managedBy: 'startup',
}
