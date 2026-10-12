import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, WorkspaceSchema, withAdvancedDefaults,
  type AgentConfigurationVersion, type HarnessExecution, type CompatibilityHarness } from '@foreman-code/contracts'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { type AcceptedNodePlacement, type DispatchIntent, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { type RunStartV3Input, sameWorkflowValue, workflowUsesAgentPlacements } from '@foreman-code/contracts/wave25'
import { readImmutableWorkflowVersion, IMMUTABLE_WORKFLOW_VERSION_COLUMNS, type ImmutableWorkflowVersionRow } from '../workflows/immutableRead.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { RegistryHarnessSelection } from '../harnesses/installationRegistry.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { RepeatNodeRef } from '../runs/repeatResolution.js'
import { beforeGraphCommit, type GraphSqlClient, type GraphTransactionSql,
  withExclusiveGraphConnection } from '../run-graph/connection.js'
import { requiredLocationAccess } from '../workspaces/location.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { readPlacementHarnessFacts } from './harnessFacts.js'
import { freezePlacement, deriveDispatch, directoryIdentityHash, placementDigest } from './binding.js'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { legacyProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'
import { readAcceptedPlacement, insertDispatchIntent } from './persistence.js'
import type { RunPlacementAdmissionPort, PreparedRunPlacementAdmission } from './startPort.js'
import { resolveBoundRootPlacement, resolveLocalMainPlacement, resolveWorkflowRootBinding } from './localMainPlacement.js'
import { bindGeneratedWorktreeRun, generatedWorktreePrefix } from '../sources/worktreeRequest.js'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'

/** Installed main-owned producer: saved immutable versions and W09/W07/HRT
 * authorities supply every pin. No request/Board JSON becomes a runtime grant. */
export class AgentPlacementProducer implements RunPlacementAdmissionPort {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly sources: SourceAdmissionPort, private readonly roots: WorkspaceRootPolicyPort,
    private readonly registry: Pick<ProductionHarnessRegistry, 'installations' | 'pinOverride'>,
    private readonly qualificationSuites: Readonly<Record<CompatibilityHarness, string>>,
    private readonly workerExecution = new WorkerExecutionPolicy(),
    private readonly assertProfileReady?: (host: CanonicalMachineReference) => void,
    private readonly refreshProfileInventory?: (
      hosts: readonly CanonicalMachineReference[], signal?: AbortSignal,
    ) => Promise<void>, private readonly accounts?: ProviderAccountResolver) {}
  async prepare(input: RunStartV3Input, principal: ManagementPrincipal,
    signal?: AbortSignal, options: {
      source: 'http' | 'mcp'; sourcePreparationStarted?: () => void
    } = { source: 'mcp' }): Promise<PreparedRunPlacementAdmission | undefined> {
    signal?.throwIfAborted()
    const initial = await withExclusiveGraphConnection(this.pool, async connection => {
      const version = await this.readVersion(connection, input)
      const needsDefault = version.definition.nodes.some(node => node.kind !== 'job' && !node.placement)
      const root = needsDefault && version.definition.defaultWorktree
        ? await resolveWorkflowRootBinding({ sql: connection, principal, workspaceId: input.workspaceId,
          reference: version.definition.defaultWorktree.rootBinding, sources: this.sources }) : undefined
      const workspace = (await connection.query<{ record: unknown }>(
        'select record from workspaces where id=$1', [input.workspaceId])).rows[0]
      const repository = workspace && WorkspaceSchema.parse(workspace.record).repository
      const selected = new Map<string, SourceRootRecord>()
      let inheritedRoot = root
      if (repository) {
        for (const node of version.definition.nodes) {
          if (node.kind === 'job') continue
          let selectedRoot = root
          if (node.placement?.rootBinding && node.placement.source) {
            selectedRoot = await this.sources.resolveRootBinding(connection, principal, {
              workspaceId: input.workspaceId, ...node.placement.rootBinding, source: node.placement.source,
            })
          } else if (!selectedRoot) {
            const bindings = await connection.query<{ record: unknown }>(`select b.record from source_root_catalog c
              join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
              where c.workspace_id=$1 and b.record#>>'{selection,hostRef,kind}'='main'`, [input.workspaceId])
            if (bindings.rows.length !== 1) this.conflict()
            const saved = SourceRootRecordSchema.parse(bindings.rows[0]!.record)
            selectedRoot = await this.sources.resolveRootBinding(connection, principal, {
              workspaceId: input.workspaceId, rootId: saved.binding.rootId,
              bindingRevision: saved.binding.bindingRevision, source: saved.source,
            })
          }
          if (!node.placement) inheritedRoot = selectedRoot
          selected.set(`${selectedRoot.binding.rootId}:${selectedRoot.binding.bindingRevision}`, selectedRoot)
        }
      }
      return { version, root, repository, selected, inheritedRoot }
    })
    const savedVersion = initial.version
    signal?.throwIfAborted()
    if (!sameWorkflowValue(savedVersion.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) this.conflict()
    const hosts = savedVersion.definition.nodes.filter(node => node.kind !== 'job')
      .map(node => node.placement?.hostRef ?? initial.root?.selection.hostRef
        ?? { kind: 'main' as const, mainId: this.mainId })
    if (hosts.length) await this.refreshProfileInventory?.(hosts, signal)
    signal?.throwIfAborted()
    for (const host of hosts) this.assertProfileReady?.(host)
    if (!workflowUsesAgentPlacements(savedVersion.definition) && !initial.repository) return undefined
    if (initial.selected.size) options.sourcePreparationStarted?.()
    const refreshed = initial.selected.size ? await this.sources.prepareRunSources(principal, {
      workspaceId: input.workspaceId, commandId: input.commandId, source: options.source, roots: [...initial.selected.values()],
    }) : []
    signal?.throwIfAborted()
    const roots = new Map([...initial.selected.keys()].map((key, index) => [key, refreshed[index]!]))
    const refreshPlacement = (saved: SavedNodePlacement): SavedNodePlacement => {
      const reference = saved.rootBinding
      if (!reference) return saved
      const root = roots.get(`${reference.rootId}:${reference.bindingRevision}`)
      if (!root) return saved
      return { ...saved, source: root.source,
        rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } }
    }
    return withExclusiveGraphConnection(this.pool, connection => connection.transaction(async sql => {
      signal?.throwIfAborted()
      if (signal) beforeGraphCommit(sql, async () => signal.throwIfAborted())
      const version = await this.readVersion(sql, input)
      signal?.throwIfAborted()
      if (!sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) this.conflict()
      const nodes = version.definition.nodes.filter(node => node.kind !== 'job')
      if (!workflowUsesAgentPlacements(version.definition) && !initial.repository) return undefined
      const assertRepository = async (sql: GraphSqlClient) => {
        const row = (await sql.query<{ record: unknown }>(
          'select record from workspaces where id=$1 for share', [input.workspaceId])).rows[0]
        const repository = row && WorkspaceSchema.parse(row.record).repository
        if (!sameWorkflowValue(repository, initial.repository)) this.conflict()
      }
      await assertRepository(sql)
      const resolveMain = async (sql: GraphTransactionSql, principal: ManagementPrincipal,
        configuration: AgentConfigurationVersion) => {
        const context = { sql, principal, configuration, mainId: this.mainId, workspaceId: input.workspaceId,
          roots: this.roots, installations: this.registry.installations, qualificationSuites: this.qualificationSuites }
        if (initial.inheritedRoot) {
          return refreshPlacement(await resolveBoundRootPlacement({ ...context, root: initial.inheritedRoot }))
        }
        return refreshPlacement(await resolveLocalMainPlacement(context))
      }
      const resolveInherited = async (sql: GraphTransactionSql, principal: ManagementPrincipal,
        configuration: AgentConfigurationVersion) => {
        if (!version.definition.defaultWorktree) return resolveMain(sql, principal, configuration)
        const root = await resolveWorkflowRootBinding({ sql, principal, workspaceId: input.workspaceId,
          reference: version.definition.defaultWorktree.rootBinding, sources: this.sources })
        return refreshPlacement(await resolveBoundRootPlacement({ sql, principal, configuration, root, mainId: this.mainId,
          workspaceId: input.workspaceId, roots: this.roots, installations: this.registry.installations,
          qualificationSuites: this.qualificationSuites }))
      }
      const prepared: { pins: Omit<AcceptedNodePlacement, 'runId' | 'bindingHash'>; selection: RegistryHarnessSelection;
        saved: SavedNodePlacement; configuration: AgentConfigurationVersion; implicit: boolean;
        generatedBranch: boolean }[] = []
      for (const node of nodes) {
        signal?.throwIfAborted()
        if (node.placement && (!node.placement.source || !node.placement.rootBinding
          || node.placement.hostRef.mainId !== this.mainId)) this.conflict()
        const configRow = (await sql.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1 and workspace_id=$2 and agent_id=$3',
          [version.agentConfigurationVersionIds[node.agentId], input.workspaceId, node.agentId])).rows[0]
        const config = AgentConfigurationVersionSchema.parse(configRow?.record)
        const saved = node.placement ? refreshPlacement(node.placement) : await resolveInherited(sql, principal, config)
        this.assertProfileReady?.(saved.hostRef)
        if (saved) this.workerExecution.requireEnabled(saved.hostRef)
        if (saved && (saved.relativeCwd.length > 1024 || saved.relativeCwd.includes('\0') || posix.isAbsolute(saved.relativeCwd)
          || saved.relativeCwd.split('/').some(component => component === '..' || component === '.' || component === '' && saved.relativeCwd !== '')
          || saved.cwdPolicy === 'project-root' && saved.relativeCwd !== '' || saved.cwdPolicy === 'project-subdirectory' && saved.relativeCwd === '')) this.conflict()
        if (!saved?.source || !saved.rootBinding || saved.hostRef.mainId !== this.mainId) this.conflict()
        const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId: input.workspaceId, ...saved!.rootBinding!, source: saved!.source! })
        const approved = await this.sources.resolveApprovedSource(sql, principal, input.workspaceId, root.source)
        const branchPrefix = node.worktree?.branchPrefix ?? version.definition.defaultWorktree?.branchPrefix
        const repository = approved.manifest.git?.repository
        if (branchPrefix && (!repository || root.binding.accessMode !== 'exclusive-write')) {
          throw new DomainError('WORKTREE_BRANCH_UNAVAILABLE',
            'An Agent branch prefix requires a writable Git repository source.', 409)
        }
        const worktree = repository && root.binding.accessMode === 'exclusive-write'
          ? { repository, branch: branchPrefix ?? generatedWorktreePrefix(version.definition.name,
            node.name ?? node.label ?? config.agentId) } : undefined
        signal?.throwIfAborted()
        if (requiredLocationAccess([config]) === 'read-write' && root.binding.accessMode !== 'exclusive-write') this.conflict()
        const policy = await this.roots.resolve(sql, principal, { workspaceId: input.workspaceId, hostRef: saved!.hostRef,
          rootPolicyId: saved!.rootPolicyId, rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision })
        signal?.throwIfAborted()
        if (saved!.projectRoot !== policy.canonicalProjectRoot) this.conflict()
        if (!sameWorkflowValue(root.selection, { hostRef: saved!.hostRef, rootPolicyId: saved!.rootPolicyId,
          rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision }) || !sameWorkflowValue(policy.registration, root.registration)) this.conflict()
        const instance = await this.readInstance(sql, saved!.instanceId)
        if (!instance.enabled || instance.instanceRevision !== saved!.instanceRevision
          || !sameWorkflowValue(instance.target.hostRef, saved!.hostRef)
          || !sameWorkflowValue(withAdvancedDefaults(instance.configuration), withAdvancedDefaults(config.harness))
          || instance.driverId !== config.harness.harness) this.conflict()
        this.assertProfileReady?.(instance.target.hostRef)
        const selection = this.registry.pinOverride(instance)
        const account = this.accounts && config.harness.harness !== 'opencode' && config.harness.accountId
          ? await this.accounts.resolve(config.harness.harness, config.harness.accountId, { allowDefault: false }) : null
        const accountBinding = account?.binding ?? legacyProviderAccountBinding(config.harness, config.harnessProfileSelection)
        prepared.push({ selection, saved, configuration: config, implicit: !node.placement,
          generatedBranch: !!worktree && !branchPrefix,
          pins: { schemaVersion: 1, mainId: this.mainId, mainInstallationId: this.mainId,
          ...(!node.placement ? { labelAtAcceptance: version.definition.defaultWorktree ? 'Workflow default' : 'Main' } : {}),
          nodeId: node.id, hostRef: saved!.hostRef, registration: root.registration,
          destination: { canonicalProjectRoot: policy.canonicalProjectRoot, canonicalCwd: posix.join(policy.canonicalProjectRoot, saved!.relativeCwd),
            managedRuntimeRoot: policy.managedRuntimeRoot,
            directoryIdentityHash: directoryIdentityHash(saved!.hostRef, root.binding.filesystem.device, root.binding.filesystem.inode),
            rootPolicyId: saved!.rootPolicyId, rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision,
            attestationId: root.attestationId, attestationHash: root.attestationDigest },
          source: { kind: 'pending', ...root.source, revisionId: root.source.snapshotId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, materializationId: null, materializationDigest: null },
          payload: { kind: 'agent', agentId: config.agentId, agentConfigurationVersionId: config.id,
            ...(accountBinding ? { accountBinding } : {}),
            ...(worktree ? { worktree } : {}),
            ...(node.artifactOutputs ? { artifactOutputs: structuredClone(node.artifactOutputs) } : {}),
            driverId: selection.selection.driverId, driverRevision: selection.installation.driverRevision,
            instanceId: selection.selection.instanceId, instanceRevision: selection.selection.instanceRevision,
            harnessInstallationId: selection.selection.harnessInstallationId, installationFingerprint: selection.selection.installationFingerprint,
            runtimeContractVersion: 1, protocolRevision: selection.installation.protocolRevision, credentialScopeRefs: [] } } })
      }
      for (const item of prepared) {
        const facts = await readPlacementHarnessFacts(sql, item.pins, this.registry.installations, this.qualificationSuites)
        signal?.throwIfAborted()
        if (item.pins.payload.kind !== 'agent') this.conflict()
        item.pins.payload.profileProofDigest = placementDigest(facts.profileProof)
        if (facts.qualification) item.pins.payload.qualificationDigest = placementDigest(facts.qualification)
      }
      const bind = (item: typeof prepared[number], runId: string) => {
        const pins = structuredClone(item.pins)
        if (item.generatedBranch && pins.payload.kind === 'agent' && pins.payload.worktree) {
          pins.payload.worktree.branch = bindGeneratedWorktreeRun(pins.payload.worktree.branch, runId)
        }
        return freezePlacement({ ...pins, runId })
      }
      return { bind: runId => prepared.map(item => bind(item, runId)),
        fence: transaction => ({ assertCurrent: async pin => {
          const saved = prepared.find(item => item.pins.nodeId === pin.nodeId)
          if (!saved || !sameWorkflowValue(bind(saved, pin.runId), pin)) this.conflict()
          this.registry.installations.assertCurrent(saved!.selection)
          if (this.accounts && pin.payload.kind === 'agent' && pin.payload.accountBinding?.kind === 'slot') {
            const binding = pin.payload.accountBinding
            await this.accounts.resolve(binding.provider, binding.accountId, { sql: transaction,
              allowDefault: false, acceptedBinding: binding })
          }
          const live = await readLiveManagementPrincipal(transaction, principal.id)
          await assertRepository(transaction)
          if (saved.implicit && !sameWorkflowValue(saved.saved, await resolveInherited(transaction, live, saved.configuration))) {
            this.conflict()
          }
          await this.assertPinsCurrent(transaction, pin, live, input.workspaceId)
        } }) }
    }))
  }
  private async readVersion(sql: GraphSqlClient, input: RunStartV3Input) {
    const row = (await sql.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
      from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
    [input.workflowVersionId, input.workspaceId, input.workflowId])).rows[0]
    if (!row) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'Exact saved workflow version is required.', 404)
    return readImmutableWorkflowVersion(row)
  }
  harnessFacts(sql: GraphTransactionSql, pin: AcceptedNodePlacement, options?: { purpose: 'resident' }) {
    return readPlacementHarnessFacts(sql, pin, this.registry.installations, this.qualificationSuites, options)
  }
  async assertPinsCurrent(sql: GraphSqlClient, pin: AcceptedNodePlacement,
    principal: ManagementPrincipal, workspaceId: string, options?: { purpose: 'resident' }): Promise<void> {
    if (!('kind' in pin.source) || pin.source.kind !== 'pending') this.conflict()
    const source = pin.source as Extract<AcceptedNodePlacement['source'], { kind: 'pending' }>
    const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId, rootId: source.rootId,
      bindingRevision: source.bindingRevision, source: { approvedSourceId: source.approvedSourceId, snapshotId: source.snapshotId, manifestDigest: source.manifestDigest } })
    if (!sameWorkflowValue(root.registration, pin.registration) || root.attestationDigest !== pin.destination.attestationHash) this.conflict()
    await this.roots.resolve(sql, principal, { workspaceId, hostRef: pin.hostRef, rootPolicyId: pin.destination.rootPolicyId,
      rootPolicyRevision: pin.destination.rootPolicyRevision, locationRevision: pin.destination.locationRevision })
    if (pin.payload.kind !== 'agent') this.conflict()
    if (options?.purpose !== 'resident') {
      const instance = await this.readInstance(sql, pin.payload.instanceId)
      if (!instance.enabled || instance.instanceRevision !== pin.payload.instanceRevision) this.conflict()
    }
    await readPlacementHarnessFacts(sql, pin, this.registry.installations, this.qualificationSuites, options)
    const registration = await assertDeviceHostInstallation(sql, pin.hostRef, pin.registration?.workerInstallationId ?? pin.mainInstallationId)
    if (!sameWorkflowValue(registration === null ? null : { workerInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }, pin.registration)) this.conflict()
  }
  private async readInstance(sql: GraphSqlClient, instanceId: string) {
    // Match settings append's lock so a new revision cannot cross the commit fence.
    await sql.query('select pg_advisory_xact_lock_shared(hashtext($1))', [`harness-instance:${instanceId}`])
    const row = (await sql.query<{ record: unknown }>(`select record from harness_instance_settings
      where instance_id=$1 order by revision desc limit 1 for share`, [instanceId])).rows[0]
    const parsed = HostHarnessOverrideSchema.safeParse(row?.record)
    if (!parsed.success) this.conflict()
    return parsed.data
  }
  /** Concrete same-owner admission callback after canonical execution/slot INSERT.
   * No worktree/native resource is allocated for an unselected occurrence. */
  async admitExecution(sql: GraphTransactionSql, owner: RunOwnership, execution: HarnessExecution,
    ref: RepeatNodeRef, inputDigest: string, principalId: string): Promise<DispatchIntent | undefined> {
    const pin = await readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId)
    if (!pin) return undefined
    const principal = await readLiveManagementPrincipal(sql, principalId)
    const run = (await sql.query<{ workspace_id: string }>('select workspace_id from runs where id=$1', [execution.runId])).rows[0]
    if (!run) this.conflict()
    const scheduler = await owner.readOneShotFence(sql)
    const intent = deriveDispatch(pin!, { executionId: execution.id, occurrenceId: ref.occurrence?.occurrenceId ?? null,
      occurrenceIndex: ref.occurrence?.occurrenceIndex ?? 0, technicalAttempt: execution.attempt,
      attemptId: randomUUID(), operationId: randomUUID(), inputDigest, owner: { grantId: randomUUID(), epoch: '1' } })
    await sql.query(`insert into execution_dispatch_owner_grants(execution_id,operation_id,grant_id,epoch,scheduler_owner_id,scheduler_owner_fence)
      values($1,$2,$3,$4,$5,$6)`, [execution.id, intent.operationId, intent.owner.grantId, intent.owner.epoch, scheduler.ownerId, scheduler.fence])
    const fence = { assertCurrent: (placement: AcceptedNodePlacement) => this.assertPinsCurrent(sql, placement, principal, run!.workspace_id) }
    const accepted = await insertDispatchIntent(sql, owner, intent, fence)
    beforeGraphCommit(sql, async () => { owner.assertOwned(); await owner.readOneShotFence(sql) })
    return accepted
  }
  private conflict(): never { throw new DomainError('PLACEMENT_ADMISSION_CONFLICT', 'Exact saved source, root and compatible harness placement are required.', 409) }
}
