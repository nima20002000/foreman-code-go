import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { IdSchema } from './schemaPrimitives.js'

export const CiEnrollmentReadSchema = z.object({ workspaceId: IdSchema }).strict()
export const CiEnrollmentUpdateSchema = CiEnrollmentReadSchema.extend({
  commandId: IdSchema,
  target: DeviceProvisioningTargetSchema,
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean(),
})
export const CiEnrollmentComputerSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  state: z.enum(['pending', 'disabled', 'offline', 'runtime-required', 'root-required', 'preparing', 'ready', 'failed']),
  profileIds: z.array(IdSchema),
  message: z.string().max(2000).nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict()
export const CiEnrollmentStateSchema = z.object({
  workspaceId: IdSchema,
  computers: z.array(CiEnrollmentComputerSchema),
}).strict()
/** Installed storage is a sizing bound, never qualification evidence. */
export const CiInstalledStorageSchema = z.object({
  diskBytes: z.number().int().positive().safe(),
  mutableInodes: z.number().int().positive().safe(),
}).strict()
export type CiEnrollmentComputer = z.infer<typeof CiEnrollmentComputerSchema>
export type CiEnrollmentState = z.infer<typeof CiEnrollmentStateSchema>
export type CiInstalledStorage = z.infer<typeof CiInstalledStorageSchema>
