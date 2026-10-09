import type pg from 'pg'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, ComputerMaintenanceListSchema, ComputerMaintenanceStartInputSchema,
  ComputerMaintenanceStartResultSchema, MaintenanceReplySchema, SyncedMcpServerSchema,
  type ComputerMaintenanceList, type ComputerMaintenanceStartInput, type ComputerMaintenanceStartResult,
  type MaintenanceStatus, type MaintenanceTask, type MaintenanceTaskStart, type SyncedMarketplace, type SyncedMcpServer,
} from '@foreman-code/contracts/computer-maintenance'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { ClaudePluginCatalog } from './claudePlugins.js'
import type { ComputerMaintenance } from './maintenance.js'
import { syncFingerprint } from './syncFingerprint.js'

export interface MaintenanceEndpoint {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ payload: unknown }>
}
/** What Main has installed; paired computers are brought to the same set. */
export interface FleetSources {
  codexUserMcpServers(): Promise<Record<string, unknown>>
  claudeUserMcpServers(): Promise<Record<string, unknown>>
  codexPlugins(): Promise<string[]>
  codexMarketplaces(): Promise<SyncedMarketplace[]>
  claudePlugins(): Promise<ClaudePluginCatalog>
}

const CACHE_MS = 20_000
const RUNNING_CACHE_MS = 3_000
const RETIRED_APP_SERVERS = ['graphql-app', 'graphql-operator', 'graphql-worker']

/** Server definitions safe to copy: no inline secret values. Servers needing a login are set up per computer later. */
export function syncableServers(entries: Record<string, unknown>, skipped?: (name: string) => void): SyncedMcpServer[] {
  const servers: SyncedMcpServer[] = []
  for (const [name, raw] of Object.entries(entries)) {
    if ([...APP_MCP_SERVER_NAMES, ...RETIRED_APP_SERVERS].includes(name as never) || !raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const hasSecrets = ['env', 'headers', 'http_headers', 'env_http_headers'].some(key =>
      entry[key] && typeof entry[key] === 'object' && Object.keys(entry[key] as object).length > 0)
    if (hasSecrets) {
      skipped?.(name)
      continue
    }
    const url = typeof entry.url === 'string' ? entry.url : undefined
    let candidate: unknown
    if (url) {
      candidate = { transport: 'http', name, url,
        bearerTokenEnvVar: typeof entry.bearer_token_env_var === 'string' ? entry.bearer_token_env_var : null }
    } else if (typeof entry.command === 'string') {
      candidate = { transport: 'stdio', name, command: entry.command, args: entry.args ?? [], envVars: [] }
    }
    const parsed = candidate ? SyncedMcpServerSchema.safeParse(candidate) : undefined
    if (parsed?.success) servers.push(parsed.data)
    else skipped?.(name)
  }
  return servers
}

/** Main's view of every computer's maintenance, and the one place that starts maintenance across them. */
export class FleetMaintenanceService {
  private readonly cache = new Map<string, { at: number; running?: boolean; value: Promise<MaintenanceStatus | null> }>()
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
    const result = await this.commands.execute({ principal, source, operation: 'computers.maintenance.start', commandId: input.commandId,
      targetKey: `computers-maintenance:${this.mainId}`, payload: input,
      authorize: async sql => { requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update') },
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
    })
    if (!result.replayed) return result.value
    return this.readStartedTasks(principal, ComputerMaintenanceStartResultSchema.parse(result.value))
  }

  private async readStartedTasks(principal: ManagementPrincipal,
    saved: ComputerMaintenanceStartResult): Promise<ComputerMaintenanceStartResult> {
    const known = await this.targets(principal, 'settings:update')
    return ComputerMaintenanceStartResultSchema.parse({ computers: await Promise.all(saved.computers.map(async computer => {
      if (!computer.task) return computer
      if (!known.some(target => sameDeviceProvisioningTarget(target, computer.target))) {
        return { ...computer, task: null, error: 'This computer is no longer paired with this Main.' }
      }
      const taskId = computer.task.id
      const status = await this.status(computer.target, true)
      const task = status?.tasks.find(task => task.id === taskId)
      if (task) return { ...computer, task }
      if (computer.task.state !== 'running') return computer
      return { ...computer, task: null, error: status
        ? 'This maintenance task is no longer retained. Read current status before starting another command.'
        : 'The computer is unavailable; this maintenance task could not be read back.' }
    })) })
  }

  /** Background upkeep: current harnesses everywhere, then Main's MCP servers and plugins on every paired computer. */
  async keepCurrent(): Promise<void> {
    const targets = await this.allTargets()
    const sync = await Promise.allSettled([this.taskFor({ kind: 'sync-mcp' }), this.taskFor({ kind: 'sync-plugins' })])
    await Promise.all(targets.map(async target => {
      const status = await this.status(target, true)
      if (!status) return
      const behind = status.harnesses.filter(entry => entry.latest && entry.version !== entry.latest).map(entry => entry.harness)
      if (behind.length) await this.startOn(target, { kind: 'update-harnesses', harnesses: behind }).catch(() => undefined)
      if (target.hostRef.kind === 'main') return
      for (const task of sync) {
        if (task.status === 'fulfilled') await this.startOn(target, task.value)
      }
    }))
    const failures = sync.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Some fleet settings could not be read.')
  }

  private readonly deliveries = new Map<string, {
    fingerprint: string; taskId: string; state: 'pending' | 'delivered'
  }>()
  /**
   * Pushes Main's current MCP servers and plugins to every connected computer that has not received this exact set yet.
   * Runs every minute on Main, so installs and removals on Main reach the other computers within about a minute, and a
   * computer that was offline catches up when it is back.
   */
  async syncChangedSources(): Promise<void> {
    const sources = await Promise.allSettled([this.taskFor({ kind: 'sync-mcp' }), this.taskFor({ kind: 'sync-plugins' })])
    const targets = (await this.allTargets()).filter(target => target.hostRef.kind !== 'main')
    await Promise.all(targets.map(async target => {
      const pending = sources.some(source => source.status === 'fulfilled'
        && this.deliveries.get(`${this.key(target)}:${source.value.kind}`)?.state === 'pending')
      const status = pending ? await this.status(target, true) : null
      await Promise.all(sources.map(async source => {
        if (source.status === 'fulfilled') await this.syncSource(target, source.value, status)
      }))
    }))
    const failures = sources.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Some fleet settings could not be read.')
  }

  private async syncSource(target: DeviceProvisioningTarget, source: MaintenanceTaskStart,
    status: MaintenanceStatus | null): Promise<void> {
    const key = `${this.key(target)}:${source.kind}`
    const fingerprint = syncFingerprint(source)
    const delivery = this.deliveries.get(key)
    if (delivery?.fingerprint === fingerprint) {
      if (delivery.state === 'delivered') return
      const task = status?.tasks.find(task => task.id === delivery.taskId && task.sourceFingerprint === fingerprint)
      if (task?.state === 'succeeded') {
        delivery.state = 'delivered'
        return
      }
      if (task?.state === 'running' || !status) return
    }
    // A failed/missing task remains pending for retry, including after a Worker restart.
    const result = await Promise.allSettled([this.startOn(target, source)])
    const started = result[0]!
    if (started.status !== 'fulfilled' || started.value.sourceFingerprint !== fingerprint) return
    this.deliveries.set(key, { fingerprint, taskId: started.value.id,
      state: started.value.state === 'succeeded' ? 'delivered' : 'pending' })
  }

  private async taskFor(task: ComputerMaintenanceStartInput['task']): Promise<MaintenanceTaskStart> {
    if (task.kind === 'sync-mcp') {
      const catalogs = await Promise.allSettled([
        this.sources.codexUserMcpServers(), this.sources.claudeUserMcpServers(),
      ])
      const servers: Extract<MaintenanceTaskStart, { kind: 'sync-mcp' }>['servers'] = {}
      const warnings: string[] = []
      for (const [index, harness] of (['codex', 'claude'] as const).entries()) {
        const catalog = catalogs[index]!
        if (catalog.status === 'rejected') warnings.push(`${harness} MCP catalog could not be read; skipped.`)
        else servers[harness] = syncableServers(catalog.value,
          name => { warnings.push(`${harness} MCP server ${name.slice(0, 100)} is unsafe or invalid; skipped.`) })
      }
      if (servers.codex === undefined && servers.claude === undefined) {
        throw new Error('Main\'s MCP catalogs could not be read.')
      }
      return { kind: 'sync-mcp', servers, ...(warnings.length ? { warnings } : {}) }
    }
    if (task.kind === 'sync-plugins') {
      const [codex, claude] = await Promise.allSettled([
        Promise.all([this.sources.codexPlugins(), this.sources.codexMarketplaces()]), this.sources.claudePlugins(),
      ])
      if (codex.status === 'rejected' && claude.status === 'rejected') {
        throw new Error('Main\'s plugin catalogs could not be read.')
      }
      const request: Extract<MaintenanceTaskStart, { kind: 'sync-plugins' }> = { kind: 'sync-plugins' }
      const warnings: string[] = []
      if (codex.status === 'fulfilled') {
        request.plugins = codex.value[0]
        request.marketplaces = codex.value[1]
      } else warnings.push('Codex plugin catalog could not be read; skipped.')
      if (claude.status === 'fulfilled') {
        request.claudePlugins = claude.value.plugins.filter(plugin => plugin.installed)
          .map(({ pluginId, enabled }) => ({ pluginId, enabled }))
        request.claudeMarketplaces = claude.value.marketplaces
          .flatMap(item => item.source ? [{ name: item.name, source: item.source }] : [])
      } else warnings.push('Claude plugin catalog could not be read; skipped.')
      if (warnings.length) request.warnings = warnings
      return request
    }
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
    // A running task's progress is read again within seconds; settled status is reused longer.
    if (!refresh && cached && this.now() - cached.at < (cached.running ? RUNNING_CACHE_MS : CACHE_MS)) return cached.value
    const value = (async () => {
      if (target.hostRef.kind === 'main') return this.local.status(AbortSignal.timeout(90_000))
      const reply = MaintenanceReplySchema.parse((await this.request(target.hostRef.deviceId, { operation: 'status' })).payload)
      return reply.operation === 'status' ? reply.status : null
    })().catch((): null => null)
    const entry: { at: number; running?: boolean; value: Promise<MaintenanceStatus | null> } = { at: this.now(), value }
    this.cache.set(key, entry)
    void value.then(status => { entry.running = status?.tasks.some(task => task.state === 'running') ?? false })
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
