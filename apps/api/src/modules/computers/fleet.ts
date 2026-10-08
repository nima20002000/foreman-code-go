import type pg from 'pg'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, ComputerMaintenanceListSchema, ComputerMaintenanceStartInputSchema,
  ComputerMaintenanceStartResultSchema, MaintenanceReplySchema, SyncedMcpServerSchema,
  type ComputerMaintenanceList, type ComputerMaintenanceStartInput, type ComputerMaintenanceStartResult,
  type MaintenanceStatus, type MaintenanceTask, type MaintenanceTaskStart, type SyncedMcpServer,
} from '@foreman-code/contracts/computer-maintenance'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { ComputerMaintenance } from './maintenance.js'

export interface MaintenanceEndpoint {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ payload: unknown }>
}
/** What Main has installed; paired computers are brought to the same set. */
export interface FleetSources {
  codexUserMcpServers(): Promise<Record<string, unknown>>
  claudeUserMcpServers(): Promise<Record<string, unknown>>
  codexPlugins(): Promise<string[]>
}

const CACHE_MS = 20_000
const RETIRED_APP_SERVERS = ['graphql-app', 'graphql-operator', 'graphql-worker']

/** Server definitions safe to copy: no inline secret values. Servers needing a login are set up per computer later. */
export function syncableServers(entries: Record<string, unknown>): SyncedMcpServer[] {
  const servers: SyncedMcpServer[] = []
  for (const [name, raw] of Object.entries(entries)) {
    if ([...APP_MCP_SERVER_NAMES, ...RETIRED_APP_SERVERS].includes(name as never) || !raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const hasSecrets = ['env', 'headers', 'http_headers', 'env_http_headers'].some(key =>
      entry[key] && typeof entry[key] === 'object' && Object.keys(entry[key] as object).length > 0)
    if (hasSecrets) continue
    const url = typeof entry.url === 'string' ? entry.url : undefined
    const candidate = url
      ? { transport: 'http', name, url, bearerTokenEnvVar: typeof entry.bearer_token_env_var === 'string' ? entry.bearer_token_env_var : null }
      : typeof entry.command === 'string'
        ? { transport: 'stdio', name, command: entry.command, args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [], envVars: [] }
        : undefined
    const parsed = candidate ? SyncedMcpServerSchema.safeParse(candidate) : undefined
    if (parsed?.success) servers.push(parsed.data)
  }
  return servers
}

/** Main's view of every computer's maintenance, and the one place that starts maintenance across them. */
export class FleetMaintenanceService {
  private readonly cache = new Map<string, { at: number; value: Promise<MaintenanceStatus | null> }>()
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly endpoint: () => MaintenanceEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly local: ComputerMaintenance,
    private readonly sources: FleetSources,
    private readonly now: () => number = Date.now,
  ) {}

  async list(principal: ManagementPrincipal, source: 'http' | 'mcp' = 'http', refresh = false): Promise<ComputerMaintenanceList> {
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computers_maintenance_status', this.mainId)
      throw error
    }
    const targets = await this.targets(principal, 'settings:read')
    return ComputerMaintenanceListSchema.parse({ computers: await Promise.all(targets.map(async target =>
      ({ target, status: await this.status(target, refresh) }))) })
  }

  async start(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: ComputerMaintenanceStartInput): Promise<ComputerMaintenanceStartResult> {
    const input = ComputerMaintenanceStartInputSchema.parse(raw)
    try { requireAuthorization(principal, 'settings:update') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computers_maintenance_start', this.mainId)
      throw error
    }
    if (input.task.kind === 'restart' && !input.targets) {
      throw new DomainError('COMPUTER_RESTART_TARGET_REQUIRED', 'Choose the computers to restart.', 400)
    }
    return (await this.commands.execute({ principal, source, operation: 'computers.maintenance.start', commandId: input.commandId,
      targetKey: `computers-maintenance:${this.mainId}`, payload: input,
      perform: async () => {
        const known = await this.targets(principal, 'settings:update')
        const selected = input.targets
          ? input.targets.map(target => known.find(value => sameDeviceProvisioningTarget(value, target)) ?? target)
          : known
        // Main is the source of MCP servers and plugins; sync brings the other computers to it.
        const targets = ['sync-mcp', 'sync-plugins'].includes(input.task.kind) ? selected.filter(target => target.hostRef.kind !== 'main') : selected
        const task = await this.taskFor(input.task)
        const computers = await Promise.all(targets.map(async target => {
          if (!known.some(value => sameDeviceProvisioningTarget(value, target))) {
            return { target, task: null, error: 'This computer is not paired with this Main.' }
          }
          try { return { target, task: await this.startOn(target, task), error: null } }
          catch (error) { return { target, task: null, error: error instanceof Error ? error.message : 'The computer did not answer.' } }
        }))
        for (const target of targets) this.cache.delete(this.key(target))
        return ComputerMaintenanceStartResultSchema.parse({ computers })
      },
    })).value
  }

  /** Background upkeep: current harnesses everywhere, then Main's MCP servers and plugins on every paired computer. */
  async keepCurrent(): Promise<void> {
    const targets = await this.allTargets()
    const sync = await Promise.all([this.taskFor({ kind: 'sync-mcp' }), this.taskFor({ kind: 'sync-plugins' })])
    await Promise.all(targets.map(async target => {
      const status = await this.status(target, true)
      if (!status) return
      const behind = status.harnesses.filter(entry => entry.latest && entry.version !== entry.latest).map(entry => entry.harness)
      if (behind.length) await this.startOn(target, { kind: 'update-harnesses', harnesses: behind }).catch(() => undefined)
      if (target.hostRef.kind === 'main') return
      for (const task of sync) await this.startOn(target, task).catch(() => undefined)
    }))
  }

  private async taskFor(task: ComputerMaintenanceStartInput['task']): Promise<MaintenanceTaskStart> {
    if (task.kind === 'sync-mcp') {
      const [codex, claude] = await Promise.all([this.sources.codexUserMcpServers().catch(() => ({})), this.sources.claudeUserMcpServers().catch(() => ({}))])
      return { kind: 'sync-mcp', servers: { codex: syncableServers(codex), claude: syncableServers(claude) } }
    }
    if (task.kind === 'sync-plugins') return { kind: 'sync-plugins', plugins: await this.sources.codexPlugins().catch(() => []) }
    return task
  }

  private async startOn(target: DeviceProvisioningTarget, task: MaintenanceTaskStart): Promise<MaintenanceTask> {
    if (target.hostRef.kind === 'main') return this.local.start(task)
    const reply = MaintenanceReplySchema.parse((await this.request(target.hostRef.deviceId, { operation: 'start', task })).payload)
    if (reply.operation !== 'start') throw new DomainError('COMPUTER_MAINTENANCE_INVALID', 'The computer returned an unexpected reply.', 502)
    return reply.task
  }

  private status(target: DeviceProvisioningTarget, refresh: boolean): Promise<MaintenanceStatus | null> {
    const key = this.key(target)
    const cached = this.cache.get(key)
    if (!refresh && cached && this.now() - cached.at < CACHE_MS) return cached.value
    const value = (async () => {
      if (target.hostRef.kind === 'main') return this.local.status(AbortSignal.timeout(90_000))
      const reply = MaintenanceReplySchema.parse((await this.request(target.hostRef.deviceId, { operation: 'status' })).payload)
      return reply.operation === 'status' ? reply.status : null
    })().catch((): null => null)
    this.cache.set(key, { at: this.now(), value })
    return value
  }

  private async request(deviceId: string, payload: unknown) {
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === COMPUTER_MAINTENANCE_NAMESPACE && value.mainCanRequest)) {
      throw new DomainError('COMPUTER_MAINTENANCE_UNAVAILABLE', 'This computer is offline or runs an app version without maintenance support.', 409)
    }
    return endpoint.request(deviceId, COMPUTER_MAINTENANCE_NAMESPACE, payload, { signal: AbortSignal.timeout(100_000), timeoutMs: 100_000 })
  }

  private key(target: DeviceProvisioningTarget) { return `${target.applicationInstallationId}:${target.authorizationRevision ?? 0}` }

  private async targets(principal: ManagementPrincipal, action: 'settings:read' | 'settings:update') {
    const sql = await this.pool.connect()
    try {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), action)
      return await this.pairedTargets(sql)
    } finally { sql.release() }
  }

  private async allTargets() {
    const sql = await this.pool.connect()
    try { return await this.pairedTargets(sql) } finally { sql.release() }
  }

  private async pairedTargets(sql: pg.PoolClient): Promise<DeviceProvisioningTarget[]> {
    const rows = await sql.query<{ record: unknown }>(`select record from device_registrations
      where main_id=$1 and record->>'status'='paired' order by id limit 100`, [this.mainId])
    return [{ hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId, keyRevision: null, authorizationRevision: null },
      ...rows.rows.map(row => DeviceRegistrationSchema.parse(row.record)).map(registration => ({
        hostRef: { kind: 'device' as const, mainId: this.mainId, deviceId: registration.deviceId },
        applicationInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
        authorizationRevision: registration.authorizationRevision }))]
  }
}
