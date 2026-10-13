import { z } from 'zod'
import { DeviceRegistrationSchema } from './deviceIdentity.js'

const IpAddress = z.union([z.ipv4(), z.ipv6()])
const Address = z.string().max(253).refine(value => IpAddress.safeParse(value).success
  || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value), 'Use an IP address or DNS hostname.')
const Fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
export const TrustedEndpointSchema = z.object({ transport: z.enum(['lan', 'tailscale']), host: Address,
  port: z.number().int().min(1).max(65535), osUser: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/) }).strict()
export type TrustedEndpoint = z.infer<typeof TrustedEndpointSchema>
const ExecutableReadinessSchema = z.object({ state: z.enum(['installed', 'missing', 'unavailable']), version: z.string().max(256).nullable() }).strict()
export const HostDiscoverySchema = z.object({ osUser: z.string(), uid: z.number().int(), platform: z.string(),
  lanAddresses: z.array(Address), tailscaleAddresses: z.array(Address),
  tailscaleState: z.enum(['running', 'authentication-required', 'stopped', 'unavailable', 'missing']),
  executables: z.object({ ssh: ExecutableReadinessSchema, rsync: ExecutableReadinessSchema, tailscale: ExecutableReadinessSchema }).strict() }).strict()
export type HostDiscovery = z.infer<typeof HostDiscoverySchema>
export const ConnectionProbeSchema = z.object({
  state: z.enum(['connected', 'authentication-required', 'host-key-mismatch', 'host-key-untrusted', 'offline', 'permission-denied', 'unavailable']),
  hostKeyFingerprint: Fingerprint.nullable(), osUser: z.string().nullable(), uid: z.number().int().nonnegative().nullable(),
  hostname: z.string().max(256).nullable(), sshVersion: z.string().max(256).nullable(), rsyncVersion: z.string().max(256).nullable(), tailscaleVersion: z.string().max(256).nullable(),
}).strict()
export type ConnectionProbe = z.infer<typeof ConnectionProbeSchema>
export const TrustedConnectionConfigureSchema = z.object({ deviceId: z.uuid(), commandId: z.string().min(8).max(200),
  expectedRevision: z.number().int().nonnegative(), expectedAuthorizationRevision: z.number().int().positive(),
  endpoint: TrustedEndpointSchema, hostKeyFingerprint: Fingerprint, allowOwnerCommands: z.boolean(), approvalId: z.uuid(),
}).strict()
export type TrustedConnectionConfigure = z.infer<typeof TrustedConnectionConfigureSchema>
export const TrustedConnectionConsentSchema = z.object({ revision: z.number().int().positive(), mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(),
  keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive(), publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  endpoint: TrustedEndpointSchema, hostKeyFingerprint: Fingerprint, allowOwnerCommands: z.boolean(), approvedBy: z.string(), approvalId: z.uuid(), approvedAt: z.string().datetime(),
  privilege: z.literal('selected-os-user'), automaticSudo: z.literal(false), grantsAgentPermissions: z.literal(false),
}).strict()
export type TrustedConnectionConsent = z.infer<typeof TrustedConnectionConsentSchema>
export const TrustedConnectionReadSchema = z.object({ registration: DeviceRegistrationSchema, consent: TrustedConnectionConsentSchema.nullable() }).strict()
export type TrustedConnectionRead = z.infer<typeof TrustedConnectionReadSchema>
export const TrustedConnectionCheckSchema = TrustedConnectionReadSchema.extend({
  state: z.enum(['pairing-required', 'revoked', 'consent-required', 'consent-revoked', 'identity-changed', 'offline', 'authentication-required', 'host-key-mismatch', 'host-key-untrusted', 'permission-denied', 'unavailable', 'tools-missing', 'ready']),
  probe: ConnectionProbeSchema.nullable(), checkedAt: z.string().datetime(),
}).strict()
export type TrustedConnectionCheck = z.infer<typeof TrustedConnectionCheckSchema>

export const TrustedConnectionApprovalRequestSchema = z.object({
  requestCommandId: z.string().min(8).max(200), action: TrustedConnectionConfigureSchema.omit({ approvalId: true }),
  applyPrincipalId: z.string().min(1).max(200).optional(),
}).strict()
export const TrustedConnectionApprovalCommandSchema = z.object({ commandId: z.string().min(8).max(200) }).strict()
export const TrustedConnectionApprovalReceiptSchema = z.object({
  id: z.uuid(), mainId: z.uuid(), ownerId: z.string().min(1),
  action: TrustedConnectionConfigureSchema, registration: DeviceRegistrationSchema,
  applyAuthority: z.object({ principalId: z.string().min(1).max(200), audience: z.literal('operator'),
    delegatedFromOwnerId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200),
    authorityHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  requestedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict()
export type TrustedConnectionApprovalReceipt = z.infer<typeof TrustedConnectionApprovalReceiptSchema>
export const TrustedConnectionApprovalReadSchema = TrustedConnectionApprovalReceiptSchema.extend({
  state: z.enum(['pending', 'approved', 'consumed', 'expired', 'stale', 'revoked']),
  approvedAt: z.string().datetime().nullable(), consumedAt: z.string().datetime().nullable(), revokedAt: z.string().datetime().nullable(),
}).strict()
export type TrustedConnectionApprovalRead = z.infer<typeof TrustedConnectionApprovalReadSchema>
