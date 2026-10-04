import { z } from 'zod'
import { DeviceProvisioningTargetSchema, DeviceCommandIdSchema, DeviceSafeIntegerSchema } from './deviceResources.js'

export const BuildComputerPreferenceSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  revision: DeviceSafeIntegerSchema,
  buildEnabled: z.boolean(),
  buildPriority: z.number().int().min(0).max(100),
}).strict()
export const BuildComputerReadSchema = z.object({ target: DeviceProvisioningTargetSchema }).strict()
export const BuildComputerUpdateSchema = BuildComputerReadSchema.extend({
  commandId: DeviceCommandIdSchema,
  expectedRevision: DeviceSafeIntegerSchema,
  buildEnabled: z.boolean(),
  buildPriority: z.number().int().min(0).max(100),
}).strict()
export const BuildComputerStatusSchema = z.object({
  preference: BuildComputerPreferenceSchema,
  state: z.enum(['disabled', 'ready', 'busy', 'offline', 'setup-required']),
  reasons: z.array(z.string()),
  remoteExecutionEnabled: z.boolean(),
}).strict()
export type BuildComputerPreference = z.infer<typeof BuildComputerPreferenceSchema>
export type BuildComputerUpdate = z.infer<typeof BuildComputerUpdateSchema>
export type BuildComputerStatus = z.infer<typeof BuildComputerStatusSchema>
