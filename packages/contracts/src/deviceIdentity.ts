import { z } from 'zod'

export const DeviceScopeSchema = z.enum(['connect', 'heartbeat'])
export const DeviceRegistrationSchema = z.object({
  mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(),
  publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), keyRevision: z.number().int().positive(),
  authorizationRevision: z.number().int().positive(), status: z.enum(['pending', 'paired', 'revoked']),
  scopes: z.array(DeviceScopeSchema),
}).strict()
export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>
export type DeviceScope = z.infer<typeof DeviceScopeSchema>
export const DevicePrincipalSchema = z.object({
  audience: z.literal('graphql-worker'), mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(),
  keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive(),
  expiresAt: z.string().datetime(),
}).strict()
export type DevicePrincipal = z.infer<typeof DevicePrincipalSchema>
export const DeviceConnectionIdentitySchema = z.object({
  mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(), bootId: z.uuid(),
  keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive(),
  connectionGeneration: z.number().int().positive(),
}).strict()
export type DeviceConnectionIdentity = z.infer<typeof DeviceConnectionIdentitySchema>
export type CanonicalMachineReference = { kind: 'main'; mainId: string } | { kind: 'device'; mainId: string; deviceId: string }

export function authorizeDevice(registration: DeviceRegistration, principal: DevicePrincipal, scope: DeviceScope, now: number): boolean {
  return principal.audience === 'graphql-worker' && registration.status === 'paired'
    && principal.mainId === registration.mainId && principal.deviceId === registration.deviceId
    && principal.workerInstallationId === registration.workerInstallationId
    && principal.keyRevision === registration.keyRevision
    && principal.authorizationRevision === registration.authorizationRevision
    && Date.parse(principal.expiresAt) > now && registration.scopes.includes(scope)
}
export function revokeDevice(registration: DeviceRegistration): DeviceRegistration {
  if (registration.status === 'revoked') return registration
  return { ...registration, status: 'revoked', authorizationRevision: registration.authorizationRevision + 1 }
}

export const WorkerPairingConfigurationSchema = z.object({
  formatVersion: z.literal(1), mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(),
  keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive(),
  endpoint: z.url().refine(value => new URL(value).protocol === 'wss:' || (new URL(value).protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(value).hostname)), 'Use verified WSS or an explicit loopback carrier.'),
  mainPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  credential: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(),
}).strict()
export type WorkerPairingConfiguration = z.infer<typeof WorkerPairingConfigurationSchema>
export const DevicePairingGrantInputSchema = z.object({ workerInstallationId: z.uuid(), publicKey: z.string().max(1024),
  expectedAuthorizationRevision: z.number().int().positive().optional(), commandId: z.string().min(8).max(200), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), scopes: z.array(DeviceScopeSchema).min(1).max(2) }).strict()
export const DeviceRevokeInputSchema = z.object({ deviceId: z.uuid(), expectedRevision: z.number().int().positive(), commandId: z.string().min(8).max(200) }).strict()
