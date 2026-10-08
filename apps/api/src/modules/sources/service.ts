import type { SourceWorktreeRequest } from '@foreman-code/contracts/source-materialization'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  SourceApproveInputSchema, SourceGetInputSchema, SourceListInputSchema, SourceRootBindInputSchema, SourceRootGetInputSchema, SourceRootListInputSchema,
  ApprovedSourceSchema, SourceRootRecordSchema, SourceMaterializationRecordSchema,
  type VerifiedSourceWorkingTree, type ApprovedSource, type ApprovedSourcePin, type SourceRootRecord, type SourceMaterializationRecord,
} from '@foreman-code/contracts/source-admission'
import type { RootBinding, SourceManifest } from '@foreman-code/contracts/source-materialization'
import { requireAuthorization } from '../access/policy.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { WorkspaceSchema, type RunExecutionLocation } from '@foreman-code/contracts'
import { captureGitSource, qualifiedGit } from './capture.js'
import { ensureClone, ensureCommit, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { importAgentSnapshot } from './agentSnapshot.js'
import { SOURCE_LIMITS, sourceSha256, verifySourceManifest } from './manifest.js'
import type { PrivateSourceSnapshotStore } from './store.js'
import { authorizeSource } from './authority.js'
import { assertAcceptedSourceRelativeCwd } from './agentSourceAuthority.js'
import { sourceBindingHash } from './bindingHash.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import type { RegisteredSourceRootPort, SourceAdmissionPort, SourceClosureProofPort } from './admissionPorts.js'
import type { MaterializationAttempt } from './ports.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { PostgresSourcePreparationReconciliation } from './preparationReconciliation.js'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import type { SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { QueuedSourcePreparationCleanup } from './queuedPreparationCleanup.js'
import { releaseUnusedSourceSnapshots } from './snapshotRetention.js'

export interface SourceExecutionHostPort {
  /** W08/CI allocated this actual attempt; this SQL-only port checks its accepted
   * owner and placement before source service can prepare a native directory. */
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal,
    input: { workspaceId: string; root: SourceRootRecord; attempt: MaterializationAttempt; operationId: string }): Promise<void>
  prepare(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt, options?: { sharedWritableTree?: true; worktree?: SourceWorktreeRequest }): Promise<SourceMaterializationRecord['receipt']>
  verifyWorkingDirectory(record: SourceMaterializationRecord, relativeCwd: string): Promise<VerifiedSourceWorkingTree>
  verify(record: SourceMaterializationRecord): Promise<string>
  releaseClaim(record: SourceMaterializationRecord, options?: { signal?: AbortSignal; deadlineAt?: string }): Promise<number>
  authorizeFinal(sql: GraphSqlClient, principal: ManagementPrincipal, record: SourceMaterializationRecord, finalDispatchBindingHash: string): Promise<void>
  reconcilePreparation?(reconciliationId: string, owner: SourceOperationOwner): Promise<SourcePreparationClosure>
}
type Transport = 'http' | 'mcp'
type Sql = GraphSqlClient
interface ApprovalRow { approved_source_id: string; snapshot_id: string; input_hash: string; state: string;
  origin: { location: RunExecutionLocation; mainId: string; ownerId: string; reservation: SourceReservation }; request: unknown }
interface SourceLifecycle {
  adopted?: ((record: SourceMaterializationRecord) => Promise<void>) | undefined
  preparationClosed?: ((closure: SourcePreparationClosure) => Promise<void>) | undefined
  closed?: ((record: SourceMaterializationRecord) => Promise<void>) | undefined
}

export class PostgresSourceService implements SourceAdmissionPort {
  readonly reservations = new PostgresSourceReservations()
  closeQueuedPreparation(ticket: JobQueueTicket): Promise<void> {
    return new QueuedSourcePreparationCleanup(this.pool, this.executions,
      this.lifecycle.preparationClosed).close(ticket)
  }
  preparationGet(principal: ManagementPrincipal, source: Transport, input: unknown) {
    return new PostgresSourcePreparationReconciliation(this.pool, this.commands, this.executions).get(principal, source, input)
  }
  preparationReconcile(principal: ManagementPrincipal, source: Transport, input: unknown) {
    return new PostgresSourcePreparationReconciliation(this.pool, this.commands, this.executions, {
      retireTransfers: this.lifecycle.preparationClosed,
    }).reconcile(principal, source, input)
  }
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly locations: WorkspaceLocationService, private readonly store: PrivateSourceSnapshotStore,
    private readonly mainId: string, private readonly roots: RegisteredSourceRootPort,
    private readonly executions: SourceExecutionHostPort, private readonly closure: SourceClosureProofPort,
    private readonly lifecycle: SourceLifecycle = {}) {}
  private async transaction<T>(work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    const sql = await this.pool.connect()
    try { await sql.query('begin'); const result = await work(sql); await sql.query('commit'); return result }
    catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
  }
  private async host(sql: Sql): Promise<void> {
    const row = (await sql.query<{ id: string }>('select id from application_installation where singleton=true for share')).rows[0]
    if (row?.id !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source authority belongs to the original configured main installation.', 403)
  }
  private async workspace(sql: Sql, workspaceId: string): Promise<void> {
    const row = (await sql.query<{ archived_at: Date | null }>('select archived_at from workspaces where id=$1 for share', [workspaceId])).rows[0]
    if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
    if (row.archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot approve sources or bind roots.', 409)
  }
  private scope(deviceId: string | null, installationId: string | null, filesystem: RootBinding['filesystem']): string {
    return `${this.mainId}:${deviceId ?? 'original-main'}:${installationId ?? this.mainId}:${filesystem.device}:${filesystem.mountId}`
  }
  async releaseUnusedSnapshots(report?: (error: unknown) => void): Promise<void> {
    const filesystem = await this.store.storageIdentity()
    await releaseUnusedSourceSnapshots(this.pool, this.store, this.scope(null, null, filesystem), report)
  }
  private async captureTransaction<T>(work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.transaction(work)
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'SOURCE_CAPACITY') throw error
      await this.releaseUnusedSnapshots()
      return this.transaction(work)
    }
  }
  async resolveApprovedSource(sql: Sql, principal: ManagementPrincipal, workspaceId: string, pin: ApprovedSourcePin): Promise<ApprovedSource> {
    await authorizeSource(sql, principal, 'sources:read', workspaceId); await this.host(sql)
    const row = (await sql.query<{ record: unknown; availability: string }>(`select record,availability from source_snapshots
      where workspace_id=$1 and approved_source_id=$2 and snapshot_id=$3 and manifest_digest=$4 for share`,
    [workspaceId, pin.approvedSourceId, pin.snapshotId, pin.manifestDigest])).rows[0]
    if (!row) throw new DomainError('SOURCE_NOT_FOUND', 'The exact approved source snapshot was not found in this workspace.', 404)
    const source = ApprovedSourceSchema.parse(row.record); verifySourceManifest(source.manifest)
    if (row.availability !== 'retained') throw new DomainError('SOURCE_UNAVAILABLE', 'The exact accepted source bytes are no longer retained.', 410)
    if (source.workspaceId !== workspaceId || source.mainId !== this.mainId || source.manifest.snapshotId !== pin.snapshotId
      || source.manifest.approvedSourceId !== pin.approvedSourceId || source.manifest.manifestDigest !== pin.manifestDigest)
      throw new DomainError('SOURCE_FACT_CONFLICT', 'Persisted source facts do not match their immutable identifiers.', 409)
    return source
  }
  async get(principal: ManagementPrincipal, _source: Transport, raw: unknown): Promise<ApprovedSource> {
    const input = SourceGetInputSchema.parse(raw)
    return this.transaction(sql => this.resolveApprovedSource(sql, principal, input.workspaceId, input))
  }
  async list(principal: ManagementPrincipal, _source: Transport, raw: unknown) {
    const input = SourceListInputSchema.parse(raw)
    return this.transaction(async sql => {
      await authorizeSource(sql, principal, 'sources:read', input.workspaceId); await this.host(sql)
      const result = await sql.query<{ record: unknown; availability: 'retained' | 'unavailable' }>(`select record,availability from source_snapshots
        where workspace_id=$1 and ($2::uuid is null or snapshot_id>$2::uuid) order by snapshot_id limit $3`, [input.workspaceId, input.afterSnapshotId ?? null, input.limit + 1])
      const items = result.rows.slice(0, input.limit).map(row => ApprovedSourceSchema.parse({ ...(row.record as object), availability: row.availability }))
      return { items, nextSnapshotId: result.rows.length > input.limit ? items.at(-1)!.manifest.snapshotId : null }
    })
  }
  /** `repository` captures from Main's own clone of the workspace's GitHub repository instead of its project folder. */
  async approve(principal: ManagementPrincipal, source: Transport, raw: unknown, repository?: { repository: string; clone: string }) {
    const input = SourceApproveInputSchema.parse(raw)
    requireAuthorization(principal, 'sources:approve', input); requireAuthorization(principal, 'sources:read', input)
    requireAuthorization(principal, 'workspace_locations:read', input)
    return this.commands.execute({ principal, source, operation: 'source.approve', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:source`, payload: input, dedicatedConnection: true,
      authorize: async sql => {
        await authorizeSource(sql, principal, 'sources:approve', input.workspaceId); await authorizeSource(sql, principal, 'sources:read', input.workspaceId); await this.host(sql)
        const prior = (await sql.query<{ availability: string }>(`select s.availability from source_approvals a join source_snapshots s on s.snapshot_id=a.snapshot_id
          where a.requested_by=$1 and a.command_id=$2`, [principal.id, input.commandId])).rows[0]
        if (prior && prior.availability !== 'retained') throw new DomainError('SOURCE_UNAVAILABLE', 'The original source approval no longer has retained bytes; command retry cannot resurrect it.', 410)
      },
      perform: async () => {
        // Existing workspace/host ownership is checked before location.snapshot
        // probes its persisted path; input has no filesystem selector.
        let origin = await this.captureTransaction(async sql => {
          const live = await authorizeSource(sql, principal, 'sources:approve', input.workspaceId)
          requireAuthorization(live.principal, 'workspace_locations:read', input)
          await this.host(sql); await this.workspace(sql, input.workspaceId)
          const existing = (await sql.query<ApprovalRow>('select * from source_approvals where requested_by=$1 and command_id=$2 for update', [principal.id, input.commandId])).rows[0]
          if (existing) {
            if (existing.input_hash !== commandInputHash(input)) throw new DomainError('COMMAND_ID_CONFLICT', 'Source approval input changed under the same command.', 409)
            if (existing.state === 'failed') throw new DomainError('SOURCE_CAPTURE_FAILED', 'This capture failed. Approve a new explicit command after correcting the source.', 409)
            return existing
          }
          const location = repository ? await this.repositoryOrigin(sql, input.workspaceId, input.expectedLocationRevision, repository)
            : await this.locations.snapshot(sql, input.workspaceId, input.expectedLocationRevision, 'read-only')
          // Authorize first, then probe only the server-owned canonical namespace.
          const fs = await this.store.storageIdentity(), approvedSourceId = randomUUID(), snapshotId = randomUUID()
          const reservation = await this.reservations.reserve(sql, { scopeId: this.scope(null, null, fs), ownerKind: 'capture', ownerId: snapshotId,
            reservedBytes: SOURCE_LIMITS.bytes + SOURCE_LIMITS.entries * 8192 + 2 * 1024 * 1024 })
          const origin = { location, mainId: this.mainId, ownerId: live.ownerId, reservation }
          await sql.query(`insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
            values($1,$2,$3,$4,$5,$6,$7,'capturing',$8::jsonb,$9::jsonb)`, [approvedSourceId, snapshotId, input.workspaceId, live.ownerId, principal.id,
            input.commandId, commandInputHash(input), JSON.stringify(origin), JSON.stringify(input)])
          return { approved_source_id: approvedSourceId, snapshot_id: snapshotId, input_hash: commandInputHash(input), state: 'capturing', origin, request: input }
        })
        let manifest: SourceManifest
        try {
          // Recover a finalized-but-unadopted exact source, never a mutable head.
          const committed = await this.store.manifest(origin.snapshot_id).catch((error: unknown) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
            throw error
          })
          manifest = committed ?? await captureGitSource({ root: origin.origin.location.rootPath, approvedSourceId: origin.approved_source_id,
            snapshotId: origin.snapshot_id, commit: input.commit, approvedPaths: input.approvedPaths, executablePolicy: input.executablePolicy, sink: this.store })
          if (manifest.approvedSourceId !== origin.approved_source_id || manifest.git?.commit !== input.commit || manifest.executablePolicy !== input.executablePolicy
            || !isDeepStrictEqual(manifest.entries.map(e => e.path).sort(), [...input.approvedPaths].sort())) throw new DomainError('SOURCE_FACT_CONFLICT', 'Recovered source bytes do not match the original approval.', 409)
          if (!repository) await this.locations.revalidateSnapshot(input.workspaceId, origin.origin.location, 'read-only')
        } catch (error) {
          await this.transaction(async sql => { await sql.query(`update source_approvals set state='failed' where approved_source_id=$1 and state='capturing'`, [origin.approved_source_id]);
            await this.reservations.retain(sql, origin.origin.reservation, 'uncertain') })
          throw error
        }
        return this.transaction(async sql => {
          const live = await authorizeSource(sql, principal, 'sources:approve', input.workspaceId)
          await authorizeSource(sql, principal, 'sources:read', input.workspaceId); requireAuthorization(live.principal, 'workspace_locations:read', input)
          await this.host(sql); await this.workspace(sql, input.workspaceId)
          const location = await sql.query<{ location_revision: string }>('select location_revision from workspaces where id=$1 for share', [input.workspaceId])
          if (Number(location.rows[0]?.location_revision) !== origin.origin.location.locationRevision || live.ownerId !== origin.origin.ownerId)
            throw new DomainError('SOURCE_APPROVAL_CONFLICT', 'Workspace location or root ownership changed during source capture.', 409)
          const approved = ApprovedSourceSchema.parse({ version: 1, workspaceId: input.workspaceId, ownerPrincipalId: live.ownerId,
            approvedByPrincipalId: principal.id, locationRevision: input.expectedLocationRevision, mainId: this.mainId,
            originIdentityHash: origin.origin.location.identityHash, manifest, approvedAt: new Date().toISOString(), availability: 'retained' })
          await sql.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)
            on conflict(snapshot_id) do nothing`, [manifest.snapshotId, manifest.approvedSourceId, input.workspaceId, manifest.manifestDigest, JSON.stringify(approved)])
          await sql.query(`update source_approvals set state='approved' where approved_source_id=$1`, [manifest.approvedSourceId])
          await this.reservations.retain(sql, origin.origin.reservation, 'retained', manifest.totalBytes + manifest.totalEntries * 8192 + 2 * 1024 * 1024)
          const row = await this.resolveApprovedSource(sql, principal, input.workspaceId, manifest)
          origin = { ...origin, state: 'approved' }; return row
        })
      } })
  }
  private async repositoryOrigin(sql: Sql, workspaceId: string, expectedLocationRevision: number, repository: { repository: string; clone: string }) {
    const row = (await sql.query<{ location_revision: string; record: unknown }>(
      'select location_revision,record from workspaces where id=$1 for share', [workspaceId])).rows[0]
    const configured = row && WorkspaceSchema.parse(row.record).repository
    if (!row || !configured || `${configured.owner}/${configured.name}` !== repository.repository) {
      throw new DomainError('SOURCE_REPOSITORY_CHANGED', 'The workspace repository changed.', 409)
    }
    if (Number(row.location_revision) !== expectedLocationRevision) {
      throw new DomainError('SOURCE_APPROVAL_CONFLICT', 'Workspace location changed during source capture.', 409)
    }
    return { runnerId: 'runner-local', rootPath: repository.clone, locationRevision: expectedLocationRevision,
      identityHash: `sha256:${createHash('sha256').update(`github:${repository.repository}`).digest('hex')}` } satisfies RunExecutionLocation
  }
  /** Main's own clone of the workspace's GitHub repository (fetched with this computer's gh sign-in). */
  git: GitWorktreePorts = systemGitWorktreePorts()
  /** Approves a commit for CI: from Main's repository clone when the workspace names a GitHub repository
   * (including an Agent's snapshot bundle), otherwise from the workspace folder on Main. */
  async approveProject(principal: ManagementPrincipal, input: {
    workspaceId: string; commandId: string; commit?: string
    snapshot?: { commit: string; baseCommit: string; bundle: Buffer }
  }): Promise<ApprovedSource> {
    await this.transaction(async sql => authorizeSource(sql, principal, 'sources:approve', input.workspaceId))
    const configured = await this.transaction(async sql => WorkspaceSchema.parse((await sql.query<{ record: unknown }>(
      'select record from workspaces where id=$1', [input.workspaceId])).rows[0]?.record ?? { id: input.workspaceId, name: '-' }).repository)
    let repository = configured ? { repository: `${configured.owner}/${configured.name}`,
      clone: this.git.cloneDirectory(`${configured.owner}/${configured.name}`) } : undefined
    const payload = { workspaceId: input.workspaceId, commandId: input.commandId,
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.snapshot ? { snapshot: { commit: input.snapshot.commit, baseCommit: input.snapshot.baseCommit,
        bundleDigest: sourceSha256(input.snapshot.bundle) } } : {}) }
    const captured = await this.commands.execute({ principal, source: 'mcp',
      operation: 'source.project.capture', commandId: input.commandId, targetKey: input.workspaceId,
      payload, dedicatedConnection: true,
      authorize: async sql => {
        await authorizeSource(sql, principal, 'sources:approve', input.workspaceId)
        await authorizeSource(sql, principal, 'sources:read', input.workspaceId)
        requireAuthorization(principal, 'workspace_locations:read', { workspaceId: input.workspaceId })
        await this.host(sql)
      },
      perform: async () => {
        const signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
        let commit = input.snapshot?.commit ?? input.commit
        if (configured) {
          const name = `${configured.owner}/${configured.name}`
          if (input.snapshot) {
            const clone = await ensureCommit(this.git, name, input.snapshot.baseCommit, signal)
            await importAgentSnapshot(this.git, clone, input.snapshot, signal)
            repository = { repository: name, clone }
          } else if (commit) repository = { repository: name, clone: await ensureCommit(this.git, name, commit, signal) }
          else {
            const clone = this.git.cloneDirectory(name)
            await ensureClone(this.git, name, signal)
            commit = await this.fetchDefaultBranch(clone, name, configured.defaultBranch, signal)
            repository = { repository: name, clone }
          }
        } else if (input.snapshot) {
          throw new DomainError('SOURCE_REPOSITORY_REQUIRED', 'Set the workspace GitHub repository before running CI on an Agent\'s files.', 409)
        }
        const location = await this.transaction(async sql => {
          await this.workspace(sql, input.workspaceId)
          const row = (await sql.query<{ location_revision: string }>(
            'select location_revision from workspaces where id=$1 for share', [input.workspaceId])).rows[0]!
          return repository ? this.repositoryOrigin(sql, input.workspaceId, Number(row.location_revision), repository)
            : this.locations.snapshot(sql, input.workspaceId, Number(row.location_revision), 'read-only')
        })
        commit ??= (await qualifiedGit(location.rootPath,
          ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim()
        const names = await qualifiedGit(location.rootPath,
          ['ls-tree', '-rz', '--name-only', '--full-tree', commit!], 8 * 1024 * 1024)
        const approvedPaths = names.toString('utf8').split('\0').filter(Boolean)
        if (!Buffer.from(names.toString('utf8')).equals(names) || approvedPaths.length > SOURCE_LIMITS.entries) {
          throw new DomainError('SOURCE_CAPACITY', 'Tracked source inventory exceeds the supported source limits.', 413)
        }
        if (!repository) await this.locations.revalidateSnapshot(input.workspaceId, location, 'read-only')
        return SourceApproveInputSchema.parse({ workspaceId: input.workspaceId, commandId: input.commandId,
          expectedLocationRevision: location.locationRevision, commit, approvedPaths,
          executablePolicy: 'preserve-approved' })
      },
    })
    return (await this.approve(principal, 'mcp', captured.value, repository)).value
  }
  private async fetchDefaultBranch(clone: string, repository: string, branch: string, signal: AbortSignal) {
    const ref = `refs/foreman/ci/fetch/${randomUUID()}`
    let commit: string
    let cleanupFailed = false
    try {
      const fetched = await this.git.git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}:${ref}`],
        { cwd: clone, signal })
      const head = fetched.code === 0
        ? await this.git.git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: clone, signal }) : fetched
      if (head.code !== 0) {
        throw new DomainError('SOURCE_REPOSITORY_UNAVAILABLE',
          `Main could not fetch ${repository}@${branch}. Sign GitHub in on Main.`, 409)
      }
      commit = head.stdout.trim()
    } finally {
      const removed = await this.git.git(['update-ref', '-d', ref], { cwd: clone, signal })
      cleanupFailed = removed.code !== 0
    }
    if (cleanupFailed) {
      throw new DomainError('SOURCE_REPOSITORY_UNAVAILABLE', 'Main could not remove its temporary fetch ref.', 409)
    }
    return commit
  }
  async resolveRootBinding(sql: Sql, principal: ManagementPrincipal,
    input: { workspaceId: string; rootId: string; bindingRevision: number; source: ApprovedSourcePin }): Promise<SourceRootRecord> {
    await authorizeSource(sql, principal, 'source_roots:read', input.workspaceId)
    await this.resolveApprovedSource(sql, principal, input.workspaceId, input.source)
    const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where workspace_id=$1 and root_id=$2 and binding_revision=$3 for share',
      [input.workspaceId, input.rootId, input.bindingRevision])).rows[0]
    if (!row) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The exact authorized root binding was not found.', 404)
    const root = SourceRootRecordSchema.parse(row.record)
    if (!isDeepStrictEqual(root.source, input.source) || root.binding.rootId !== input.rootId || root.binding.bindingRevision !== input.bindingRevision
      || root.binding.workspaceId !== input.workspaceId || root.binding.mainId !== this.mainId)
      throw new DomainError('SOURCE_ROOT_CONFLICT', 'The accepted root/source pins changed.', 409)
    return root
  }
  async rootGet(principal: ManagementPrincipal, _source: Transport, raw: unknown): Promise<SourceRootRecord> {
    const input = SourceRootGetInputSchema.parse(raw)
    return this.transaction(async sql => {
      await authorizeSource(sql, principal, 'source_roots:read', input.workspaceId); await this.host(sql)
      const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where workspace_id=$1 and root_id=$2 and binding_revision=$3',
        [input.workspaceId, input.rootId, input.bindingRevision])).rows[0]
      if (!row) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The exact root binding was not found.', 404)
      const record = SourceRootRecordSchema.parse(row.record)
      return this.resolveRootBinding(sql, principal, { ...input, source: record.source })
    })
  }
  async rootList(principal: ManagementPrincipal, _source: Transport, raw: unknown) {
    const input = SourceRootListInputSchema.parse(raw)
    return this.transaction(async sql => {
      await authorizeSource(sql, principal, 'source_roots:read', input.workspaceId)
      await authorizeSource(sql, principal, 'sources:read', input.workspaceId); await this.host(sql)
      const rows = await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c join source_root_bindings b
        on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision where c.workspace_id=$1 order by c.root_id limit $2`, [input.workspaceId, input.limit])
      return { items: rows.rows.map(row => SourceRootRecordSchema.parse(row.record)), readiness: 'metadata-only' as const }
    })
  }
  async bindRoot(principal: ManagementPrincipal, source: Transport, raw: unknown) {
    const input = SourceRootBindInputSchema.parse(raw)
    requireAuthorization(principal, 'source_roots:bind', input)
    requireAuthorization(principal, 'source_roots:read', input); requireAuthorization(principal, 'workspace_locations:read', input)
    if (input.selection.hostRef.mainId !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source root belongs to another main installation.', 403)
    return this.commands.execute({ principal, source, operation: 'source.root.bind', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:source-root`, payload: input, dedicatedConnection: true,
      authorize: async sql => { await authorizeSource(sql, principal, 'source_roots:bind', input.workspaceId); await authorizeSource(sql, principal, 'source_roots:read', input.workspaceId); await this.resolveApprovedSource(sql, principal, input.workspaceId, input.source) },
      perform: async () => {
        const authorized = await this.transaction(async sql => {
          const live = await authorizeSource(sql, principal, 'source_roots:bind', input.workspaceId)
          await authorizeSource(sql, principal, 'source_roots:read', input.workspaceId)
          await this.resolveApprovedSource(sql, principal, input.workspaceId, input.source); await this.workspace(sql, input.workspaceId)
          const root = await this.roots.authorize(sql, live.principal, input)
          if (root.mainId !== this.mainId || root.workspaceId !== input.workspaceId || root.ownerPrincipalId !== live.ownerId
            || !isDeepStrictEqual(root.selection, input.selection)
            || (input.selection.hostRef.kind === 'main' ? root.deviceId !== null || root.workerInstallationId !== null || root.keyRevision !== null || root.authorizationRevision !== null
              : root.deviceId !== input.selection.hostRef.deviceId || root.workerInstallationId === null || root.keyRevision === null || root.authorizationRevision === null)) throw new DomainError('SOURCE_ROOT_CONFLICT', 'Root catalog authority does not match the approved workspace/host.', 409)
          return root
        })
        const attestation = await this.roots.attest(authorized)
        if (attestation.canonicalPath !== authorized.canonicalPath) throw new DomainError('SOURCE_ROOT_CONFLICT', 'The host attested a different root namespace.', 409)
        return this.transaction(async sql => {
          const live = await authorizeSource(sql, principal, 'source_roots:bind', input.workspaceId)
          await authorizeSource(sql, principal, 'source_roots:read', input.workspaceId)
          await this.resolveApprovedSource(sql, principal, input.workspaceId, input.source)
          await this.roots.fence(sql, authorized)
          const scope = sourceSha256(Buffer.from(JSON.stringify({ workspaceId: input.workspaceId, hostRef: input.selection.hostRef, rootPolicyId: input.selection.rootPolicyId })))
          await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-root:${scope}`])
          const existing = (await sql.query<{ root_id: string; current_binding_revision: string }>('select root_id,current_binding_revision from source_root_catalog where scope_hash=$1 for update', [scope])).rows[0]
          const revision = Number(existing?.current_binding_revision ?? 0)
          if (revision !== input.expectedBindingRevision) throw new DomainError('SOURCE_ROOT_REVISION_CONFLICT', 'The root binding changed since it was read.', 409)
          const rootId = existing?.root_id ?? randomUUID()
          if (!existing) await sql.query('insert into source_root_catalog(root_id,workspace_id,scope_hash) values($1,$2,$3)', [rootId, input.workspaceId, scope])
          const record = SourceRootRecordSchema.parse({ version: 1, source: input.source, selection: input.selection,
            binding: { version: 1, mainId: this.mainId, deviceId: authorized.deviceId, workerInstallationId: authorized.workerInstallationId,
              workspaceId: input.workspaceId, rootId, bindingRevision: revision + 1, locationRevision: Number(input.selection.locationRevision),
              canonicalPath: attestation.canonicalPath, filesystem: attestation.filesystem, accessMode: input.accessMode,
              snapshotId: input.source.snapshotId, manifestDigest: input.source.manifestDigest },
            ownerPrincipalId: live.ownerId, authorizedByPrincipalId: principal.id, registration: authorized.deviceId === null ? null : { workerInstallationId: authorized.workerInstallationId, keyRevision: authorized.keyRevision, authorizationRevision: authorized.authorizationRevision }, attestationId: attestation.attestationId,
            attestationDigest: attestation.attestationDigest, boundAt: new Date().toISOString() })
          await sql.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,$2,$3,$4,$5::jsonb)',
            [rootId, revision + 1, input.workspaceId, input.source.snapshotId, JSON.stringify(record)])
          await sql.query('update source_root_catalog set current_binding_revision=$2 where root_id=$1', [rootId, revision + 1])
          return record
        })
      } })
  }
  async prepareExecution(input: { principal: ManagementPrincipal; workspaceId: string; rootId: string; bindingRevision: number;
    source: ApprovedSourcePin; attempt: MaterializationAttempt; operationId: string }): Promise<SourceMaterializationRecord> {
    const state = await this.transaction(async sql => {
      const root = await this.resolveRootBinding(sql, input.principal, input)
      const source = await this.resolveApprovedSource(sql, input.principal, input.workspaceId, input.source)
      if ((await sql.query('select 1 from source_preparation_reconciliations where operation_id=$1', [input.operationId])).rowCount)
        throw new DomainError('SOURCE_PREPARATION_RECONCILED', 'The original preparation is fenced for reconciliation and cannot regain execution authority.', 409)
      if (input.attempt.placementHash !== sourceBindingHash(root, input.attempt, input.operationId)
        || (root.registration === null ? input.attempt.keyRevision !== null || input.attempt.authorizationRevision !== null
          : input.attempt.keyRevision !== root.registration.keyRevision || input.attempt.authorizationRevision !== root.registration.authorizationRevision))
        throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Preparation must use the exact approved source/root and actual host authorization pins.', 409)
      await this.executions.authorize(sql, input.principal, { ...input, root })
      const existing = (await sql.query<{ record: unknown; state: string }>('select record,state from source_execution_materializations where execution_id=$1 and attempt_id=$2 for update', [input.attempt.executionId, input.attempt.attemptId])).rows[0]
      if (existing) {
        const record = SourceMaterializationRecordSchema.parse({ ...(existing.record as object), state: existing.state })
        if (record.operationId !== input.operationId || !isDeepStrictEqual(record.receipt.binding, root.binding)
          || record.receipt.placementHash !== input.attempt.placementHash) throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Source preparation belongs to another exact execution/attempt.', 409)
        return { root, source, record, reservation: null, sharedWritableTree: false }
      }
      const reservation = await this.reservations.reserve(sql, { scopeId: this.scope(root.binding.deviceId, root.binding.workerInstallationId, root.binding.filesystem),
        ownerKind: 'materialization', ownerId: input.operationId, reservedBytes: source.manifest.totalBytes * 3 + source.manifest.totalEntries * 8192 + 2 * 1024 * 1024 })
      const workflow = await sql.query('select 1 from execution_dispatch_intents where execution_id=$1 and attempt_id=$2 and operation_id=$3',
        [input.attempt.executionId, input.attempt.attemptId, input.operationId])
      const sharedWritableTree = root.binding.accessMode === 'exclusive-write' && workflow.rowCount === 1
      return { root, source, record: null, reservation, sharedWritableTree,
        worktree: sharedWritableTree ? await agentWorktree(sql, input.attempt.executionId) : undefined }
    })
    if (state.record) { await this.lifecycle.adopted?.(state.record); return state.record }
    // No main SQL transaction spans carrier/native filesystem I/O.
    const receipt = await this.executions.prepare(state.source.manifest, state.root, input.attempt,
      state.sharedWritableTree ? { sharedWritableTree: true, ...(state.worktree ? { worktree: state.worktree } : {}) } : undefined)
    if (!isDeepStrictEqual(receipt.binding, state.root.binding) || receipt.executionId !== input.attempt.executionId
      || receipt.attemptId !== input.attempt.attemptId || receipt.placementHash !== input.attempt.placementHash
      || receipt.keyRevision !== input.attempt.keyRevision || receipt.authorizationRevision !== input.attempt.authorizationRevision
      || receipt.verifiedManifestDigest !== state.source.manifest.manifestDigest || receipt.verifiedEntries !== state.source.manifest.totalEntries
      || receipt.verifiedBytes !== state.source.manifest.totalBytes)
      throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Materialization did not attest the accepted original execution/attempt.', 409)
    const record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId: state.root.selection.rootPolicyId,
      rootPolicyRevision: state.root.selection.rootPolicyRevision, operationId: input.operationId, reservationId: state.reservation!.reservationId, sourceBindingHash: input.attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
    const committed = await this.transaction(async sql => {
      await this.resolveRootBinding(sql, input.principal, input)
      await this.executions.authorize(sql, input.principal, { ...input, root: state.root })
      await sql.query(`insert into source_execution_materializations(materialization_id,workspace_id,execution_id,attempt_id,operation_id,root_id,binding_revision,reservation_id,record,state)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'prepared')`, [receipt.materializationId, input.workspaceId, receipt.executionId, receipt.attemptId, input.operationId,
        input.rootId, input.bindingRevision, state.reservation!.reservationId, JSON.stringify(record)])
      await this.reservations.retain(sql, state.reservation!, 'owned'); return record
    })
    await this.lifecycle.adopted?.(committed); return committed
  }
  async verifyPreparation(input: { principal: ManagementPrincipal; record: SourceMaterializationRecord }): Promise<string> {
    return this.verifyPrepared(input, false)
  }
  async verifyWorkingDirectory(input: { principal: ManagementPrincipal; record: SourceMaterializationRecord; relativeCwd: string }): Promise<VerifiedSourceWorkingTree> {
    const record = SourceMaterializationRecordSchema.parse(input.record)
    await this.transaction(async sql => {
      const stored = (await sql.query<{ record: unknown; state: string }>('select record,state from source_execution_materializations where materialization_id=$1 for share', [record.receipt.materializationId])).rows[0]
      if (!stored || !isDeepStrictEqual(stored.record, record) || !['prepared', 'running'].includes(stored.state))
        throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Only the exact retained original source attempt may verify its working directory.', 409)
      const root = await this.rootGetInTransaction(sql, input.principal, record)
      await this.executions.authorize(sql, input.principal, { workspaceId: root.binding.workspaceId, root, attempt: record.receipt, operationId: record.operationId })
      if (record.finalDispatchBindingHash) await this.executions.authorizeFinal(sql, input.principal, record, record.finalDispatchBindingHash)
      await assertAcceptedSourceRelativeCwd(sql, record.receipt.executionId, input.relativeCwd)
    })
    return this.executions.verifyWorkingDirectory(record, input.relativeCwd)
  }
  async verifyExecution(input: { principal: ManagementPrincipal; record: SourceMaterializationRecord }): Promise<string> {
    return this.verifyPrepared(input, true)
  }
  private async verifyPrepared(input: { principal: ManagementPrincipal; record: SourceMaterializationRecord }, final: boolean): Promise<string> {
    const record = SourceMaterializationRecordSchema.parse(input.record)
    if (final && !record.finalDispatchBindingHash) throw new DomainError('SOURCE_DISPATCH_NOT_ADOPTED', 'Source-ready is not native entry authority; the main must adopt the final dispatch binding.', 409)
    await this.transaction(async sql => {
      const stored = (await sql.query<{ record: unknown; state: string }>('select record,state from source_execution_materializations where materialization_id=$1 for share', [record.receipt.materializationId])).rows[0]
      if (!stored || !isDeepStrictEqual(stored.record, record) || stored.state !== 'prepared') throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Only the exact retained prepared attempt may enter native execution.', 409)
      const root = await this.rootGetInTransaction(sql, input.principal, record)
      await this.executions.authorize(sql, input.principal, { workspaceId: root.binding.workspaceId, root,
        attempt: record.receipt, operationId: record.operationId })
      if (final) await this.executions.authorizeFinal(sql, input.principal, record, record.finalDispatchBindingHash!)
    })
    return this.executions.verify(record)
  }
  async adoptFinalBinding(sql: Sql, principal: ManagementPrincipal, raw: SourceMaterializationRecord, finalDispatchBindingHash: string): Promise<SourceMaterializationRecord> {
    const record = SourceMaterializationRecordSchema.parse(raw)
    if (!/^[a-f0-9]{64}$/.test(finalDispatchBindingHash)) throw new DomainError('SOURCE_DISPATCH_INVALID', 'An exact final dispatch binding is required.', 409)
    await this.rootGetInTransaction(sql, principal, record)
    await this.executions.authorizeFinal(sql, principal, record, finalDispatchBindingHash)
    const stored = (await sql.query<{ record: unknown }>('select record from source_execution_materializations where materialization_id=$1 for update', [record.receipt.materializationId])).rows[0]
    if (!stored) throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The prepared source attempt is missing.', 409)
    const current = SourceMaterializationRecordSchema.parse(stored.record)
    if (!isDeepStrictEqual({ ...current, finalDispatchBindingHash: null }, { ...record, finalDispatchBindingHash: null })
      || (current.finalDispatchBindingHash !== null && current.finalDispatchBindingHash !== finalDispatchBindingHash))
      throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Final dispatch adoption cannot replace the accepted source or attempt.', 409)
    const adopted = { ...current, finalDispatchBindingHash }
    await sql.query('update source_execution_materializations set record=$2::jsonb where materialization_id=$1', [record.receipt.materializationId, JSON.stringify(adopted)])
    return adopted
  }
  private async rootGetInTransaction(sql: Sql, principal: ManagementPrincipal, record: SourceMaterializationRecord): Promise<SourceRootRecord> {
    const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share', [record.receipt.binding.rootId, record.receipt.binding.bindingRevision])).rows[0]
    if (!row) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The accepted root binding is missing.', 404)
    const root = SourceRootRecordSchema.parse(row.record)
    return this.resolveRootBinding(sql, principal, { workspaceId: root.binding.workspaceId, rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision, source: root.source })
  }
  async confirmClosed(record: SourceMaterializationRecord, options?: { signal?: AbortSignal; deadlineAt?: string }): Promise<void> {
    record = SourceMaterializationRecordSchema.parse(record)
    options?.signal?.throwIfAborted()
    if (!await this.closure.confirmedClosed(record)) throw new DomainError('SOURCE_EXECUTION_UNCERTAIN', 'Original execution physical closure is not confirmed.', 409)
    if (record.receipt.quota) {
      const binding = record.receipt.binding
      const retained = (await this.pool.query<{ availability: string }>(
        'select availability from source_snapshots where workspace_id=$1 and snapshot_id=$2 and manifest_digest=$3',
        [binding.workspaceId, binding.snapshotId, binding.manifestDigest])).rows[0]
      const manifest = await this.store.manifest(binding.snapshotId)
      if (retained?.availability !== 'retained' || manifest.manifestDigest !== binding.manifestDigest) {
        throw new DomainError('SOURCE_UNAVAILABLE', 'The canonical source must remain retained before Job quota cleanup.', 409)
      }
      const signal = options?.signal ?? AbortSignal.timeout(60_000)
      for (const entry of manifest.entries) await this.store.read(manifest, entry, signal)
    }
    const physicalBytes = await this.executions.releaseClaim(record, options)
    const retainedBytes = physicalBytes + 16 * 1024
    const quotaReclaimed = Boolean(record.receipt.quota && physicalBytes === 0)
    await this.lifecycle.closed?.(record)
    await this.transaction(async sql => {
      const row = (await sql.query<{ record: unknown }>('select record from source_execution_materializations where materialization_id=$1 for update', [record.receipt.materializationId])).rows[0]
      if (!row || !isDeepStrictEqual(row.record, record)) throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Closure does not match the original materialization.', 409)
      await sql.query(`update source_execution_materializations set state='closed' where materialization_id=$1`, [record.receipt.materializationId])
      const reservation = (await sql.query<{ record: SourceReservation }>('select record from source_storage_reservations where reservation_id=$1', [record.reservationId])).rows[0]!.record
      if (record.receipt.quota) {
        await this.reservations.reclaimed(sql, reservation, async () => quotaReclaimed
          && await this.closure.confirmedClosed(record))
      } else {
        await this.reservations.retain(sql, reservation, 'retained', retainedBytes)
      }
    })
  }
}

const slug = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'agent'
/** A workflow agent in a GitHub workspace works on its own branch: foreman/<workflow>/<agent>-<run>. */
async function agentWorktree(sql: Sql, executionId: string): Promise<SourceWorktreeRequest | undefined> {
  const row = (await sql.query<{ workspace: unknown; workflow_name: string | null; agent_name: string | null; run_id: string }>(
    `select ws.record as workspace, v.record#>>'{definition,name}' as workflow_name, a.record->>'name' as agent_name, e.run_id
     from harness_executions e join runs r on r.id=e.run_id join workspaces ws on ws.id=r.workspace_id
     left join workflow_versions v on v.id=r.workflow_version_id left join agents a on a.id=e.record->>'agentId'
     where e.id=$1`, [executionId])).rows[0]
  const repository = row && WorkspaceSchema.parse(row.workspace).repository
  if (!row || !repository) return undefined
  const run = row.run_id.replace(/^run-/u, '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 8)
  return { repository: `${repository.owner}/${repository.name}`,
    branch: `foreman/${slug(row.workflow_name ?? 'workflow')}/${slug(row.agent_name ?? 'agent')}-${run}` }
}
