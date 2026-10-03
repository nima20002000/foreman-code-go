import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, type HarnessExecution, type CompatibilityHarness } from '@graphql/contracts'
import { type AcceptedNodePlacement, type DispatchIntent } from '@graphql/contracts/node-placement'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { type RunStartV3Input, sameWorkflowValue } from '@graphql/contracts/wave25'
import { readImmutableWorkflowVersion, IMMUTABLE_WORKFLOW_VERSION_COLUMNS, type ImmutableWorkflowVersionRow } from '../workflows/immutableRead.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { HarnessInstallationRegistry, RegistryHarnessSelection } from '../harnesses/installationRegistry.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { RepeatNodeRef } from '../runs/repeatResolution.js'
import { beforeGraphCommit, type GraphTransactionSql, withExclusiveGraphConnection } from '../run-graph/connection.js'
import { requiredLocationAccess } from '../workspaces/location.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { readPlacementHarnessFacts } from './harnessFacts.js'
import { freezePlacement, deriveDispatch, directoryIdentityHash, placementDigest } from './binding.js'
import { readAcceptedPlacement, insertDispatchIntent } from './persistence.js'
import type { RunPlacementAdmissionPort, PreparedRunPlacementAdmission } from './startPort.js'

/** Installed main-owned producer: saved immutable versions and W09/W07/HRT
 * authorities supply every pin. No request/Board JSON becomes a runtime grant. */
export class AgentPlacementProducer implements RunPlacementAdmissionPort {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly sources: SourceAdmissionPort, private readonly roots: WorkspaceRootPolicyPort,
    private readonly installations: HarnessInstallationRegistry,
    private readonly qualificationSuites: Readonly<Record<CompatibilityHarness, string>>,
    private readonly workerExecution = new WorkerExecutionPolicy()) {}
  async prepare(input: RunStartV3Input, principal: ManagementPrincipal): Promise<PreparedRunPlacementAdmission | undefined> {
    return withExclusiveGraphConnection(this.pool, connection => connection.transaction(async sql => {
      const row = (await sql.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions
        where id=$1 and workspace_id=$2 and workflow_id=$3`, [input.workflowVersionId, input.workspaceId, input.workflowId])).rows[0]
      if (!row) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'Exact saved workflow version is required.', 404)
      const version = readImmutableWorkflowVersion(row)
      if (!sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) this.conflict()
      const nodes = version.definition.nodes.filter(node => node.kind !== 'job')
      // Unplaced local workflows keep the original path. Mixed placed/unplaced
      // Agent nodes cannot fabricate evidence for the unplaced members.
      if (!nodes.some(node => node.placement)) return undefined
      const prepared: { pins: Omit<AcceptedNodePlacement, 'runId' | 'bindingHash'>; selection: RegistryHarnessSelection }[] = []
      for (const node of nodes) {
        const saved = node.placement
        if (saved) this.workerExecution.requireEnabled(saved.hostRef)
        if (saved && (saved.relativeCwd.length > 1024 || saved.relativeCwd.includes('\0') || posix.isAbsolute(saved.relativeCwd)
          || saved.relativeCwd.split('/').some(component => component === '..' || component === '.' || component === '' && saved.relativeCwd !== '')
          || saved.cwdPolicy === 'project-root' && saved.relativeCwd !== '' || saved.cwdPolicy === 'project-subdirectory' && saved.relativeCwd === '')) this.conflict()
        if (!saved?.source || !saved.rootBinding || saved.hostRef.mainId !== this.mainId) this.conflict()
        const configRow = (await sql.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1 and workspace_id=$2 and agent_id=$3',
          [version.agentConfigurationVersionIds[node.agentId], input.workspaceId, node.agentId])).rows[0]
        const config = AgentConfigurationVersionSchema.parse(configRow?.record)
        const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId: input.workspaceId, ...saved!.rootBinding!, source: saved!.source! })
        if (requiredLocationAccess([config]) === 'read-write' && root.binding.accessMode !== 'exclusive-write') this.conflict()
        const policy = await this.roots.resolve(sql, principal, { workspaceId: input.workspaceId, hostRef: saved!.hostRef,
          rootPolicyId: saved!.rootPolicyId, rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision })
        if (saved!.projectRoot !== policy.canonicalProjectRoot) this.conflict()
        if (!sameWorkflowValue(root.selection, { hostRef: saved!.hostRef, rootPolicyId: saved!.rootPolicyId,
          rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision }) || !sameWorkflowValue(policy.registration, root.registration)) this.conflict()
        const installation = this.installations.list().find(item => item.harnessInstallationId === saved!.harnessInstallationId && sameWorkflowValue(item.hostRef, saved!.hostRef))
        if (!installation || installation.compatible !== true || installation.authenticated !== true) this.conflict()
        const selection = this.installations.pin({ instanceId: saved!.instanceId, hostRef: saved!.hostRef,
          harnessInstallationId: saved!.harnessInstallationId, connectionGeneration: installation!.connectionGeneration, environmentGeneration: installation!.environmentGeneration })
        if (selection.instance.instanceRevision !== saved!.instanceRevision || !sameWorkflowValue(selection.instance.configuration, config.harness)
          || selection.instance.driverId !== config.harness.harness) this.conflict()
        prepared.push({ selection, pins: { schemaVersion: 1, mainId: this.mainId, mainInstallationId: this.mainId,
          nodeId: node.id, hostRef: saved!.hostRef, registration: root.registration,
          destination: { canonicalProjectRoot: policy.canonicalProjectRoot, canonicalCwd: posix.join(policy.canonicalProjectRoot, saved!.relativeCwd),
            managedRuntimeRoot: policy.managedRuntimeRoot,
            directoryIdentityHash: directoryIdentityHash(saved!.hostRef, root.binding.filesystem.device, root.binding.filesystem.inode),
            rootPolicyId: saved!.rootPolicyId, rootPolicyRevision: saved!.rootPolicyRevision, locationRevision: saved!.locationRevision,
            attestationId: root.attestationId, attestationHash: root.attestationDigest },
          source: { kind: 'pending', ...root.source, revisionId: root.source.snapshotId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, materializationId: null, materializationDigest: null },
          payload: { kind: 'agent', agentId: config.agentId, agentConfigurationVersionId: config.id,
            ...(node.artifactOutputs ? { artifactOutputs: structuredClone(node.artifactOutputs) } : {}),
            driverId: selection.selection.driverId, driverRevision: selection.installation.driverRevision,
            instanceId: selection.selection.instanceId, instanceRevision: selection.selection.instanceRevision,
            harnessInstallationId: selection.selection.harnessInstallationId, installationFingerprint: selection.selection.installationFingerprint,
            runtimeContractVersion: 1, protocolRevision: selection.installation.protocolRevision, credentialScopeRefs: [] } } })
      }
      for (const item of prepared) {
        const facts = await readPlacementHarnessFacts(sql, item.pins, this.installations, this.qualificationSuites)
        if (item.pins.payload.kind !== 'agent') this.conflict()
        item.pins.payload.profileProofDigest = placementDigest(facts.profileProof)
        item.pins.payload.qualificationDigest = placementDigest(facts.qualification)
      }
      return { bind: runId => prepared.map(({ pins }) => freezePlacement({ ...pins, runId })),
        fence: transaction => ({ assertCurrent: async pin => {
          const saved = prepared.find(item => item.pins.nodeId === pin.nodeId)
          if (!saved || !sameWorkflowValue(freezePlacement({ ...saved.pins, runId: pin.runId }), pin)) this.conflict()
          this.installations.assertCurrent(saved!.selection)
          await this.assertPinsCurrent(transaction, pin, await readLiveManagementPrincipal(transaction, principal.id), input.workspaceId)
        } }) }
    }))
  }
  harnessFacts(sql: GraphTransactionSql, pin: AcceptedNodePlacement) { return readPlacementHarnessFacts(sql, pin, this.installations, this.qualificationSuites) }
  async assertPinsCurrent(sql: import('../run-graph/connection.js').GraphSqlClient, pin: AcceptedNodePlacement, principal: ManagementPrincipal, workspaceId: string): Promise<void> {
    if (!('kind' in pin.source) || pin.source.kind !== 'pending') this.conflict()
    const source = pin.source as Extract<AcceptedNodePlacement['source'], { kind: 'pending' }>
    const root = await this.sources.resolveRootBinding(sql, principal, { workspaceId, rootId: source.rootId,
      bindingRevision: source.bindingRevision, source: { approvedSourceId: source.approvedSourceId, snapshotId: source.snapshotId, manifestDigest: source.manifestDigest } })
    if (!sameWorkflowValue(root.registration, pin.registration) || root.attestationDigest !== pin.destination.attestationHash) this.conflict()
    await this.roots.resolve(sql, principal, { workspaceId, hostRef: pin.hostRef, rootPolicyId: pin.destination.rootPolicyId,
      rootPolicyRevision: pin.destination.rootPolicyRevision, locationRevision: pin.destination.locationRevision })
    await readPlacementHarnessFacts(sql, pin, this.installations, this.qualificationSuites)
    const registration = await assertDeviceHostInstallation(sql, pin.hostRef, pin.registration?.workerInstallationId ?? pin.mainInstallationId)
    if (!sameWorkflowValue(registration === null ? null : { workerInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }, pin.registration)) this.conflict()
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
