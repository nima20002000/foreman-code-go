import { z } from 'zod'
import { DeviceProvisioningTargetSchema, DeviceCommandIdSchema, DeviceSafeIntegerSchema } from './deviceResources.js'

/** Primary computers take builds first; a backup is used only when no primary has room. */
export const BuildComputerRoleSchema = z.enum(['primary', 'backup'])
/** Share (percent) of the computer's CPU and memory that builds may use together. */
export const BuildComputerAllowanceSchema = z.number().int().min(10).max(100)
export const BuildComputerPreferenceSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  revision: DeviceSafeIntegerSchema,
  buildEnabled: z.boolean(),
  buildPriority: z.number().int().min(0).max(100),
  buildRole: BuildComputerRoleSchema.default('primary'),
  buildAllowancePercent: BuildComputerAllowanceSchema.default(100),
}).strict()
export const BuildComputerReadSchema = z.object({ target: DeviceProvisioningTargetSchema }).strict()
export const BuildComputerUpdateSchema = BuildComputerReadSchema.extend({
  commandId: DeviceCommandIdSchema,
  expectedRevision: DeviceSafeIntegerSchema,
  buildEnabled: z.boolean(),
  buildPriority: z.number().int().min(0).max(100),
  /** Omitted fields keep their saved values. */
  buildRole: BuildComputerRoleSchema.optional(),
  buildAllowancePercent: BuildComputerAllowanceSchema.optional(),
}).strict()
export const BuildComputerStatusSchema = z.object({
  preference: BuildComputerPreferenceSchema,
  state: z.enum(['disabled', 'ready', 'busy', 'offline', 'setup-required']),
  reasons: z.array(z.string()),
  remoteExecutionEnabled: z.boolean(),
}).strict()
export type BuildComputerPreference = z.infer<typeof BuildComputerPreferenceSchema>
export type BuildComputerRole = z.infer<typeof BuildComputerRoleSchema>
export type BuildComputerUpdate = z.infer<typeof BuildComputerUpdateSchema>
export type BuildComputerStatus = z.infer<typeof BuildComputerStatusSchema>
