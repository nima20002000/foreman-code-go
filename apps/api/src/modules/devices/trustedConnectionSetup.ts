import type pg from 'pg'
import { z } from 'zod'
import { DeviceRegistrationSchema, type DeviceRegistration } from '@graphql/contracts/device-identity'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { ConnectionProbeSchema, TrustedEndpointSchema, probeTrustedConnection, discoverTrustedConnectionHost, type HostDiscovery, type ConnectionProbe } from './trustedConnectionProbe.js'

import { TrustedConnectionConfigureSchema, TrustedConnectionConsentSchema, TrustedConnectionReadSchema, TrustedConnectionCheckSchema, type TrustedConnectionConfigure, type TrustedConnectionConsent, type TrustedConnectionRead, type TrustedConnectionCheck } from '@graphql/contracts/trusted-device-connection'
export { TrustedConnectionConfigureSchema, TrustedConnectionConsentSchema, TrustedConnectionReadSchema, TrustedConnectionCheckSchema } from '@graphql/contracts/trusted-device-connection'
export type { TrustedConnectionConfigure, TrustedConnectionConsent, TrustedConnectionRead, TrustedConnectionCheck } from '@graphql/contracts/trusted-device-connection'
const OPERATION = 'device.trusted-connection.configure'
export interface TrustedConnectionSetupPorts {
  /** Verify/consume an existing explicit human owner approval in this SQL transaction.
   * Must bind device identity/revisions, endpoint/user, host fingerprint and allow/revoke.
   * A caller boolean, an Operator grant or SSH login is never owner approval. */
  verifyOwnerApproval(client: pg.PoolClient, principal: ManagementPrincipal, input: TrustedConnectionConfigure, registration: DeviceRegistration): Promise<{ ownerId: string }>
  probe?: typeof probeTrustedConnection
}
function blocked(read: TrustedConnectionRead): TrustedConnectionCheck['state'] | null {
  if (read.registration.status === 'revoked') return 'revoked'
  if (read.registration.status !== 'paired') return 'pairing-required'
  if (!read.consent) return 'consent-required'
  if (!read.consent.allowOwnerCommands) return 'consent-revoked'
  if (read.consent.mainId !== read.registration.mainId || read.consent.deviceId !== read.registration.deviceId
    || read.consent.workerInstallationId !== read.registration.workerInstallationId || read.consent.keyRevision !== read.registration.keyRevision
    || read.consent.authorizationRevision !== read.registration.authorizationRevision || read.consent.publicKeyFingerprint !== read.registration.publicKeyFingerprint) return 'identity-changed'
  return null
}
/** Consent and diagnostic readiness only. Does not dispatch commands, install software,
 * enable SSH/Tailscale, modify known_hosts, or confer agent execution authority. */
export class PostgresTrustedConnectionSetup {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string, private readonly ports: TrustedConnectionSetupPorts) {}
  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('begin'); const result = await operation(client); await client.query('commit'); return result }
    catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  private async readLocked(client: pg.PoolClient, principal: ManagementPrincipal, deviceId: string, write = false): Promise<TrustedConnectionRead> {
    requireAuthorization(principal, write ? 'settings:update' : 'settings:read')
    requireAuthorization(await readLiveManagementPrincipal(client, principal.id), write ? 'settings:update' : 'settings:read')
    if (write) await client.query('select pg_advisory_xact_lock(hashtext($1))', [`trusted-connection:${this.mainId}:${deviceId}`])
    const row = (await client.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2 for share', [deviceId, this.mainId])).rows[0]
    if (!row) throw new DomainError('DEVICE_NOT_FOUND', 'The device is not registered on this Main.', 404)
    const registration = DeviceRegistrationSchema.parse(row.record)
    const latest = (await client.query<{ result: unknown }>(`select result from management_command_receipts where operation=$1 and target_key=$2 order by (result->>'revision')::bigint desc limit 1`, [OPERATION, `${this.mainId}:${deviceId}`])).rows[0]
    return TrustedConnectionReadSchema.parse({ registration, consent: latest ? latest.result : null })
  }
  async discover(principal: ManagementPrincipal): Promise<HostDiscovery> {
    const authorize = () => this.transaction(async client => {
      requireAuthorization(principal, 'settings:read')
      requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:read')
    })
    await authorize()
    const facts = await discoverTrustedConnectionHost()
    await authorize()
    return facts
  }
  async read(principal: ManagementPrincipal, rawDeviceId: string): Promise<TrustedConnectionRead> {
    const deviceId = z.uuid().parse(rawDeviceId)
    return this.transaction(client => this.readLocked(client, principal, deviceId))
  }
  async configure(principal: ManagementPrincipal, raw: TrustedConnectionConfigure, source: 'http' | 'mcp' = 'http'): Promise<TrustedConnectionConsent> {
    const input = TrustedConnectionConfigureSchema.parse(raw)
    requireAuthorization(principal, 'settings:update')
    const result = await new PostgresCommandCoordinator(this.pool).execute({ principal, source, operation: OPERATION,
      commandId: input.commandId, targetKey: `${this.mainId}:${input.deviceId}`, payload: input,
      authorize: async client => { await this.readLocked(client, principal, input.deviceId, true) },
      perform: async client => {
        const current = await this.readLocked(client, principal, input.deviceId, true)
        if ((current.consent?.revision ?? 0) !== input.expectedRevision || current.registration.authorizationRevision !== input.expectedAuthorizationRevision) {
          throw new DomainError('DEVICE_CONNECTION_CONFLICT', 'The device or consent revision changed. Read it before approving again.', 409)
        }
        if (current.registration.status !== 'paired') throw new DomainError('DEVICE_CONNECTION_NOT_PAIRED', 'Pair this device before approving remote commands.', 409)
        if (!this.ports.verifyOwnerApproval) throw new DomainError('DEVICE_OWNER_APPROVAL_UNAVAILABLE', 'Owner approval verification is not configured.', 503)
        const approval = await this.ports.verifyOwnerApproval(client, principal, input, current.registration)
        const approvedBy = z.string().min(1).max(200).parse(approval.ownerId)
        const { mainId, deviceId, workerInstallationId, keyRevision, authorizationRevision, publicKeyFingerprint } = current.registration
        return TrustedConnectionConsentSchema.parse({ mainId, deviceId, workerInstallationId, keyRevision, authorizationRevision, publicKeyFingerprint,
          revision: input.expectedRevision + 1, endpoint: input.endpoint, hostKeyFingerprint: input.hostKeyFingerprint,
          allowOwnerCommands: input.allowOwnerCommands, approvedBy, approvalId: input.approvalId, approvedAt: new Date().toISOString(),
          privilege: 'selected-os-user', automaticSudo: false, grantsAgentPermissions: false })
      } })
    return TrustedConnectionConsentSchema.parse(result.value)
  }
  async inspect(principal: ManagementPrincipal, deviceId: string, rawEndpoint: z.infer<typeof TrustedEndpointSchema>): Promise<ConnectionProbe> {
    const endpoint = TrustedEndpointSchema.parse(rawEndpoint)
    const before = await this.read(principal, deviceId)
    if (before.registration.status !== 'paired') throw new DomainError('DEVICE_CONNECTION_NOT_PAIRED', 'Pair this device before testing its connection.', 409)
    const probe = ConnectionProbeSchema.parse(await (this.ports.probe ?? probeTrustedConnection)(endpoint))
    const after = await this.read(principal, deviceId)
    if (after.registration.status !== 'paired' || JSON.stringify(after.registration) !== JSON.stringify(before.registration)) {
      throw new DomainError('DEVICE_CONNECTION_CONFLICT', 'The paired identity changed during the connection test.', 409)
    }
    return probe
  }
  async check(principal: ManagementPrincipal, deviceId: string): Promise<TrustedConnectionCheck> {
    const before = await this.read(principal, deviceId)
    const initial = blocked(before)
    if (initial) return TrustedConnectionCheckSchema.parse({ ...before, state: initial, probe: null, checkedAt: new Date().toISOString() })
    const consent = before.consent!
    // No SQL locks across network waits; revalidate everything after the probe.
    const probe = ConnectionProbeSchema.parse(await (this.ports.probe ?? probeTrustedConnection)(consent.endpoint))
    const after = await this.read(principal, deviceId)
    const fence = blocked(after)
    const changed = after.consent?.revision !== consent.revision
    const state = fence ?? (changed ? 'consent-required' : probe.state !== 'connected' ? probe.state
      : probe.hostKeyFingerprint !== consent.hostKeyFingerprint ? 'host-key-mismatch'
      : probe.osUser !== consent.endpoint.osUser ? 'permission-denied'
      : !probe.sshVersion || !probe.rsyncVersion || consent.endpoint.transport === 'tailscale' && !probe.tailscaleVersion ? 'tools-missing' : 'ready')
    return TrustedConnectionCheckSchema.parse({ ...after, state, probe: fence || changed ? null : probe, checkedAt: new Date().toISOString() })
  }
}
