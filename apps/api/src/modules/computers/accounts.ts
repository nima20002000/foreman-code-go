import type pg from 'pg'
import { COMPUTER_ACCOUNTS_NAMESPACE, ComputerAccountsListSchema, ComputerAccountsSchema,
  type ComputerAccounts, type ComputerAccountsList } from '@foreman-code/contracts/computer-accounts'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { probeComputerAccounts } from './accountProbe.js'

export interface ComputerAccountsEndpoint {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: { signal?: AbortSignal }): Promise<{ payload: unknown }>
}
const CACHE_MS = 30_000

/** Which harness, GitHub and Drive accounts each paired computer is signed in to. Identity strings only. */
export class ComputerAccountsService {
  private readonly cache = new Map<string, { at: number; value: Promise<ComputerAccounts | null> }>()
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly probeMain: () => Promise<ComputerAccounts> = () => probeComputerAccounts(),
    private readonly now: () => number = Date.now,
  ) {}

  async list(principal: ManagementPrincipal, source: 'http' | 'mcp' = 'http', refresh = false,
    cursor?: string): Promise<ComputerAccountsList> {
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computer_accounts_list', this.mainId)
      throw error
    }
    const sql = await this.pool.connect()
    let targets: DeviceProvisioningTarget[]
    let nextCursor: string | null = null
    try {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:read')
      const rows = await sql.query<{ record: unknown }>(`select record from device_registrations
        where main_id=$1 and record->>'status'='paired' and ($2::uuid is null or id>$2::uuid)
        order by id limit 101`, [this.mainId, cursor ?? null])
      const registrations = rows.rows.map(row => DeviceRegistrationSchema.parse(row.record))
      const page = registrations.slice(0, 100)
      if (registrations.length > page.length) nextCursor = page.at(-1)!.deviceId
      targets = cursor ? [] : [{ hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId,
        keyRevision: null, authorizationRevision: null }]
      targets.push(...page.map(registration => {
        return { hostRef: { kind: 'device' as const, mainId: this.mainId, deviceId: registration.deviceId },
          applicationInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
          authorizationRevision: registration.authorizationRevision }
      }))
    } finally { sql.release() }
    const computers = await Promise.all(targets.map(async target => ({ target, accounts: await this.read(target, refresh) })))
    return ComputerAccountsListSchema.parse({ computers, nextCursor })
  }

  /** Where Google Drive is mounted on that computer, for the Agents placed there; null when it is not mounted. */
  async driveMount(hostRef: { kind: 'main' } | { kind: 'device'; deviceId: string }): Promise<string | null> {
    let target: DeviceProvisioningTarget = { hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId,
      keyRevision: null, authorizationRevision: null }
    if (hostRef.kind === 'device') {
      const row = (await this.pool.query<{ record: unknown }>(`select record from device_registrations
        where main_id=$1 and record->>'deviceId'=$2 and record->>'status'='paired' limit 1`, [this.mainId, hostRef.deviceId])).rows[0]
      if (!row) return null
      const registration = DeviceRegistrationSchema.parse(row.record)
      target = { hostRef: { kind: 'device', mainId: this.mainId, deviceId: registration.deviceId },
        applicationInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
        authorizationRevision: registration.authorizationRevision }
    }
    const drive = (await this.read(target, false))?.accounts.find(account => account.tool === 'drive' && account.signedIn)
    return drive?.details.find(detail => detail.startsWith('mount:'))?.slice('mount:'.length) ?? null
  }

  private read(target: DeviceProvisioningTarget, refresh: boolean): Promise<ComputerAccounts | null> {
    const key = `${target.applicationInstallationId}:${target.authorizationRevision ?? 0}`
    const cached = this.cache.get(key)
    if (!refresh && cached && this.now() - cached.at < CACHE_MS) return cached.value
    const value = (target.hostRef.kind === 'main' ? this.probeMain() : this.readDevice(target.hostRef.deviceId))
      .catch((): null => null)
    this.cache.set(key, { at: this.now(), value })
    return value
  }

  private async readDevice(deviceId: string): Promise<ComputerAccounts | null> {
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === COMPUTER_ACCOUNTS_NAMESPACE && value.mainCanRequest)) return null
    const reply = await endpoint.request(deviceId, COMPUTER_ACCOUNTS_NAMESPACE, { operation: 'read' },
      { signal: AbortSignal.timeout(25_000) })
    return ComputerAccountsSchema.parse(reply.payload)
  }
}
