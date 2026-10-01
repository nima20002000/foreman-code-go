import { z } from 'zod'
import { HarnessConfigurationSchema } from './index.js'
import type { CanonicalMachineReference } from './deviceIdentity.js'

export const HarnessHostReferenceSchema: z.ZodType<CanonicalMachineReference> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), mainId: z.uuid() }).strict(),
  z.object({ kind: z.literal('device'), mainId: z.uuid(), deviceId: z.uuid() }).strict(),
])
const Identity = z.string().min(1)
export const HarnessInstanceAvailabilitySchema = z.enum(['available', 'disabled', 'unknown-driver', 'invalid-configuration'])
export const ConfiguredHarnessInstanceSchema = z.object({
  instanceId: Identity, instanceRevision: Identity, driverId: Identity, enabled: z.boolean(),
  // Unrecognized configuration stays unavailable; raw unknown data is never exposed to clients.
  configuration: z.lazy(() => HarnessConfigurationSchema).nullable(),
  availability: HarnessInstanceAvailabilitySchema, driverRevision: Identity.optional(),
}).strict()
export type ConfiguredHarnessInstanceDto = z.infer<typeof ConfiguredHarnessInstanceSchema>
export const HarnessTargetEnvironmentSchema = z.object({
  generation: Identity, provenance: z.enum(['terminal', 'gui', 'systemd', 'ssh', 'worker']), cwd: z.string(), path: z.string(),
}).strict()
export const HarnessLauncherEvidenceSchema = z.object({
  requested: z.string(), resolvedLauncher: z.string().nullable(), fingerprint: z.string().nullable(),
  payloadFingerprints: z.array(z.object({ path: z.string(), fingerprint: Identity }).strict()).optional(),
  status: z.enum(['installed', 'missing', 'not-executable', 'broken-symlink', 'missing-interpreter', 'unreadable']),
  interpreter: z.string().nullable(), diagnostics: z.array(z.string()), environment: HarnessTargetEnvironmentSchema, checkedAt: z.string().datetime(),
}).strict()
export const HostHarnessInstallationSchema = z.object({
  hostRef: HarnessHostReferenceSchema, harnessInstallationId: Identity, installationFingerprint: Identity,
  driverId: Identity, driverRevision: Identity, protocolRevision: Identity,
  environmentGeneration: Identity, connectionGeneration: Identity,
  launcher: HarnessLauncherEvidenceSchema, observedVersion: z.string().nullable(), installed: z.boolean(),
  authenticated: z.boolean().nullable(), compatible: z.boolean().nullable(), qualified: z.boolean().nullable(),
}).strict()
export type HostHarnessInstallationDto = z.infer<typeof HostHarnessInstallationSchema>
export const PinnedHarnessSelectionSchema = z.object({
  driverId: Identity, instanceId: Identity, instanceRevision: Identity, hostRef: HarnessHostReferenceSchema,
  harnessInstallationId: Identity, installationFingerprint: Identity,
}).strict()
export type PinnedHarnessSelectionDto = z.infer<typeof PinnedHarnessSelectionSchema>
export const HarnessRegistryReadbackSchema = z.object({
  instances: z.array(ConfiguredHarnessInstanceSchema), installations: z.array(HostHarnessInstallationSchema),
}).strict()
export type HarnessRegistryReadback = z.infer<typeof HarnessRegistryReadbackSchema>


/** Global presets remain managed defaults; overrides are exact-host immutable revisions. */
export const HostHarnessOverrideTargetSchema = z.object({
  hostRef: HarnessHostReferenceSchema, applicationInstallationId: z.uuid(), harnessInstallationId: Identity,
  installationFingerprint: Identity,
}).strict()
export const HostHarnessOverrideSaveSchema = z.object({
  commandId: z.uuid(), instanceId: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  target: HostHarnessOverrideTargetSchema, presetId: Identity, enabled: z.boolean(),
  configuration: z.lazy(() => HarnessConfigurationSchema),
}).strict()
export type HostHarnessOverrideSave = z.infer<typeof HostHarnessOverrideSaveSchema>
export const HostHarnessOverrideSchema = z.object({
  instanceId: z.uuid(), revision: z.number().int().positive(), instanceRevision: Identity,
  target: HostHarnessOverrideTargetSchema, presetId: Identity, enabled: z.boolean(), driverId: Identity,
  configuration: z.lazy(() => HarnessConfigurationSchema), configurationFingerprint: Identity,
  qualification: z.enum(['unqualified', 'qualified', 'installation-changed', 'disabled']),
}).strict()
export type HostHarnessOverride = z.infer<typeof HostHarnessOverrideSchema>
export const HostHarnessOverrideListInputSchema = z.object({
  hostRef: HarnessHostReferenceSchema, applicationInstallationId: z.uuid(),
}).strict()
export type HostHarnessOverrideListInput = z.infer<typeof HostHarnessOverrideListInputSchema>
export const HostHarnessOverrideListSchema = z.object({ overrides: z.array(HostHarnessOverrideSchema) }).strict()
export const HostHarnessOverrideSaveResultSchema = z.object({ value: HostHarnessOverrideSchema, replayed: z.boolean() }).strict()
