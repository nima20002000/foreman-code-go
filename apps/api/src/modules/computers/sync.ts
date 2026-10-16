import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type pg from 'pg'
import { COMPUTER_SYNC_NAMESPACE, ComputerSyncReadInputSchema, ComputerSyncStatusSchema, ComputerSyncUpdateInputSchema,
  SyncComputerStateSchema, SyncIdentitySchema, type ComputerSyncStatus, type SyncComputerRequest,
  type SyncComputerState, type SyncIdentity } from '@foreman-code/contracts/computer-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { assertBuildComputerTarget, buildComputerKey } from '../settings/buildComputers.js'
import type { ComputerAccountsEndpoint } from './accounts.js'
import { SyncthingComputer } from './syncthingComputer.js'
import { SyncRepository, type SyncWorkspace, type SyncComputerIdentity } from './syncRepository.js'

export class ComputerSyncService {
  private readonly repository: SyncRepository
  private identities: SyncComputerIdentity[] = []
  private readonly lifetime = new AbortController()
  private queued = 0
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly local: Pick<SyncthingComputer, 'handle'> = new SyncthingComputer(),
    private readonly assertCurrent: () => void = () => {}) {
    this.repository = new SyncRepository(pool, mainId)
  }

  async read(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<ComputerSyncStatus> {
    return this.readAuthorized(principal, source, 'settings:read', raw)
  }

  private async readAuthorized(principal: ManagementPrincipal, source: 'http' | 'mcp',
    action: 'settings:read' | 'settings:update', raw: unknown): Promise<ComputerSyncStatus> {
    const { target } = ComputerSyncReadInputSchema.parse(raw)
    await this.authorize(principal, source, action, target)
    let state: SyncComputerState
    let unavailable = false
    try { state = SyncComputerStateSchema.parse(await this.computer(target, { operation: 'status' })) } catch (error) {
      unavailable = true
      state = { installed: false, running: false, deviceId: null, folders: [],
        message: error instanceof Error ? error.message.slice(0, 500) : 'Sync status is unavailable.' }
    }
    const folders = await Promise.all((await this.repository.workspaces()).filter(workspace => workspace.active).map(async workspace => ({
      workspaceId: workspace.id, name: workspace.name,
      participating: workspace.targets.some(member => sameDeviceProvisioningTarget(member, target)),
      ...await this.repository.preference(this.pool, workspace.id, target),
      status: state.folders.find(folder => folder.workspaceId === workspace.id) ?? null,
    })))
    await this.authorize(principal, source, action, target)
    return ComputerSyncStatusSchema.parse({ target, installed: unavailable ? null : state.installed,
      running: unavailable ? null : state.running,
      message: state.message, folders })
  }

  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<ComputerSyncStatus> {
    const input = ComputerSyncUpdateInputSchema.parse(raw)
    await this.authorize(principal, source, 'settings:update', input.target)
    await this.commands.execute({ principal, source, commandId: input.commandId,
      operation: 'computer_sync_update', targetKey: `${input.workspaceId}:${buildComputerKey(input.target)}`, payload: input,
      authorize: async sql => {
        requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update')
        await this.assertTarget(sql, input.target)
        const workspace = (await sql.query('select id from workspaces where id=$1 for share', [input.workspaceId])).rows[0]
        if (!workspace) throw new DomainError('NOT_FOUND', 'Workspace not found.', 404)
      },
      perform: async sql => {
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`computer-sync:${input.workspaceId}`])
        const previous = await this.repository.preference(sql, input.workspaceId, input.target)
        if (input.expectedRevision !== undefined && previous.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Sync settings changed. Refresh before saving again.', 409)
        }
        const preference = { revision: previous.revision + 1, enabled: input.enabled }
        await this.repository.save(sql, input.workspaceId, input.target, preference, principal.id)
        return preference
      },
    })
    // The preference is committed before external configuration; reconnect retries the saved desired state.
    let message: string | null = null
    try { await this.reconcile() } catch (error) {
      message = error instanceof Error ? error.message.slice(0, 500) : 'Sync setup will retry when this computer reconnects.'
    }
    const status = await this.readAuthorized(principal, source, 'settings:update', { target: input.target })
    return { ...status, message: message ?? status.message }
  }

  stopAdmission(): void {
    this.lifetime.abort(new DomainError('SYNC_CLOSING', 'Shared file sync is shutting down.', 503))
  }

  async join(): Promise<void> { await this.pending }

  private assertOpen(): void {
    this.lifetime.signal.throwIfAborted()
    this.assertCurrent()
  }

  async reconcile(target?: DeviceProvisioningTarget): Promise<void> {
    const failures = await this.synchronize(target)
    if (failures.length) throw new AggregateError(failures, 'Shared file setup is pending on an unavailable computer.')
  }

  poll(): Promise<void> {
    if (this.lifetime.signal.aborted || this.queued) return Promise.resolve()
    return this.reconcile().catch(error => {
      logIgnoredError('lifecycle', 'synchronize shared files', error, { nextRetryMs: 30_000 })
      throw error
    })
  }

  private synchronize(target?: DeviceProvisioningTarget): Promise<unknown[]> {
    this.assertOpen()
    this.queued++
    const task = this.pending.then(async () => {
      this.assertOpen()
      if (target) await this.assertTarget(this.pool, target)
      this.assertOpen()
      const failures: unknown[] = []
      this.identities = await this.repository.identities()
      const workspaces = await this.repository.workspaces()
      for (const workspace of workspaces) {
        this.assertOpen()
        failures.push(...await this.configureWorkspace(workspace))
      }
      return failures
    }).finally(() => { this.queued-- })
    this.pending = task.then(() => undefined, () => undefined)
    return task
  }

  async paired(target: DeviceProvisioningTarget): Promise<void> {
    await this.reconcile(target)
  }

  async sharedFolder(workspaceId: string, host: { kind: 'main' } | { kind: 'device'; deviceId: string }): Promise<string | null> {
    const workspace = (await this.repository.workspaces()).find(value => value.id === workspaceId)
    const target = workspace?.targets.find(value => host.kind === 'main' ? value.hostRef.kind === 'main'
      : value.hostRef.kind === 'device' && value.hostRef.deviceId === host.deviceId)
    if (!workspace || !target || !(await this.repository.preference(this.pool, workspaceId, target)).enabled) return null
    if (!(await this.repository.preference(this.pool, workspaceId, this.repository.mainTarget)).enabled) return null
    // Native context reads must remain usable while optional shared-file setup is pending or the computer is slow.
    const bound = AbortSignal.timeout(10_000)
    try {
      const state = SyncComputerStateSchema.parse(await this.computer(target, { operation: 'status', workspaceId }, bound))
      return state.folders.find(folder => folder.workspaceId === workspaceId)?.path ?? null
    } catch (error) {
      if (bound.aborted || this.lifetime.signal.aborted) return null
      if (error instanceof DomainError && ['COMPUTER_OFFLINE', 'SYNC_UNAVAILABLE'].includes(error.code)) return null
      if (error instanceof DeviceApplicationError && error.retryable) return null
      throw error
    }
  }

  private async configureWorkspace(workspace: SyncWorkspace) {
    this.assertOpen()
    const main = this.repository.mainTarget
    const mainEnabled = workspace.active && (await this.repository.preference(this.pool, workspace.id, main)).enabled
    const members = await Promise.all((await this.repository.computers()).map(async target => ({ target,
      enabled: mainEnabled && workspace.targets.some(member => sameDeviceProvisioningTarget(member, target))
        && (await this.repository.preference(this.pool, workspace.id, target)).enabled })))
    const peers: { target: DeviceProvisioningTarget; identity: SyncIdentity }[] = []
    const failures: unknown[] = []
    for (const member of members) {
      this.assertOpen()
      if (!member.enabled) continue
      try { peers.push({ target: member.target, identity: await this.identity(member.target) }) } catch (error) {
        failures.push(error)
      }
    }
    const hub = peers.find(peer => peer.target.hostRef.kind === 'main')
    const known = members.flatMap(member => {
      const peer = this.identities.find(value => sameDeviceProvisioningTarget(value.target, member.target))
      return member.enabled && peer ? [peer] : []
    })
    const missingIdentity = members.some(member => member.enabled
      && !known.some(peer => sameDeviceProvisioningTarget(peer.target, member.target)))
    for (const member of members) {
      this.assertOpen()
      const selected = peers.find(peer => sameDeviceProvisioningTarget(peer.target, member.target))
      if (member.enabled && (!selected || !hub)) {
        continue
      }
      const remotePeers = member.target.hostRef.kind === 'main'
        ? known.filter(peer => peer.target.hostRef.kind === 'device').map(peer => ({
          deviceId: peer.identity.deviceId, address: peer.identity.address }))
        : hub ? [{ deviceId: hub.identity.deviceId, address: hub.identity.address }] : []
      try {
        await this.computer(member.target, { operation: 'configure', workspaceId: workspace.id,
          enabled: member.enabled && Boolean(selected) && Boolean(hub), peers: remotePeers,
          preserveUnknownPeers: member.target.hostRef.kind === 'main' && missingIdentity,
          knownPeerIds: this.identities.map(peer => peer.identity.deviceId) })
      } catch (error) { failures.push(error) }
    }
    return failures
  }

  private async identity(target: DeviceProvisioningTarget): Promise<SyncIdentity> {
    const cached = this.identities.find(peer => sameDeviceProvisioningTarget(peer.target, target))
    if (cached) return cached.identity
    const identity = SyncIdentitySchema.parse(await this.computer(target, { operation: 'identity' }))
    await this.repository.saveIdentity(target, identity)
    this.identities.push({ target, identity })
    return identity
  }
  private async computer(target: DeviceProvisioningTarget, request: SyncComputerRequest,
    signal = AbortSignal.timeout(150_000)): Promise<unknown> {
    this.assertOpen()
    signal = AbortSignal.any([signal, this.lifetime.signal])
    signal.throwIfAborted()
    await this.assertTarget(this.pool, target)
    this.assertOpen()
    signal.throwIfAborted()
    if (target.hostRef.kind === 'main') return this.local.handle(request, { signal, assertCurrent: () => this.assertOpen() })
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(target.hostRef.deviceId).some(value => value.namespace === COMPUTER_SYNC_NAMESPACE
      && value.mainCanRequest)) throw new DomainError('COMPUTER_OFFLINE', 'This computer is offline or needs an app update.', 409)
    return (await endpoint.request(target.hostRef.deviceId, COMPUTER_SYNC_NAMESPACE, { target, request },
      { signal, timeoutMs: 150_000 })).payload
  }
  private async assertTarget(sql: Pick<pg.Pool, 'query'>, target: DeviceProvisioningTarget) {
    if (target.hostRef.mainId !== this.mainId) throw new DomainError('COMPUTER_NOT_FOUND', 'Computer belongs to another Main.', 404)
    await assertBuildComputerTarget(sql, target)
  }
  private async authorize(principal: ManagementPrincipal, source: 'http' | 'mcp',
    action: 'settings:read' | 'settings:update', target: DeviceProvisioningTarget) {
    try {
      requireAuthorization(principal, action)
      const sql = await this.pool.connect()
      try {
        requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), action)
        await this.assertTarget(sql, target)
      } finally { sql.release() }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ACCESS_DENIED') {
        await this.commands.recordDenied(principal.id, source,
          action === 'settings:read' ? 'computer_sync_status' : 'computer_sync_update', buildComputerKey(target))
      }
      throw error
    }
  }
}
