import { withAdvancedDefaults, type AgentConfigurationVersion, type CompatibilityHarness } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SavedNodePlacementSchema, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { SourceRootReference } from '@foreman-code/contracts/worktree-settings'
import { HostHarnessOverrideSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { DomainError } from '../errors.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import { readPlacementHarnessFacts } from './harnessFacts.js'

const unavailable = (reason: string): never => {
  throw new DomainError('PLACEMENT_ADMISSION_CONFLICT',
    'The selected computer requires an approved source and root and a matching qualified harness profile.', 409, { reason })
}

/** Resolve only existing authorized Main choices. Admission still validates their source,
 * root, installation and qualification through the same services as explicit placements. */
export async function resolveLocalMainPlacement(input: {
  sql: GraphSqlClient
  principal: ManagementPrincipal
  mainId: string
  workspaceId: string
  configuration: AgentConfigurationVersion
  roots: WorkspaceRootPolicyPort
  installations: HarnessInstallationRegistry
  qualificationSuites: Readonly<Record<CompatibilityHarness, string>>
  assertProfileReady?: (profile: HostHarnessOverride) => void
}): Promise<SavedNodePlacement> {
  const { sql, mainId, workspaceId } = input
  const hostRef = { kind: 'main' as const, mainId }
  const bindings = await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c
    join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
    where c.workspace_id=$1 and b.record#>'{selection,hostRef}'=$2::jsonb for share of c,b`,
  [workspaceId, JSON.stringify(hostRef)])
  const root = bindings.rows[0] && SourceRootRecordSchema.parse(bindings.rows[0].record)
  if (bindings.rows.length !== 1 || !root || root.binding.workspaceId !== workspaceId) {
    return unavailable('main_source_binding')
  }
  return resolveBoundRootPlacement({ ...input, root })
}

export async function resolveWorkflowRootBinding(input: {
  sql: GraphSqlClient
  principal: ManagementPrincipal
  workspaceId: string
  reference: SourceRootReference
  sources: SourceAdmissionPort
}): Promise<SourceRootRecord> {
  const { sql, principal, workspaceId, reference } = input
  const row = (await sql.query<{ record: unknown }>(`select record from source_root_bindings
    where workspace_id=$1 and root_id=$2 and binding_revision=$3 for share`,
  [workspaceId, reference.rootId, reference.bindingRevision])).rows[0]
  if (!row) return unavailable('workflow_source_binding')
  const root = SourceRootRecordSchema.parse(row.record)
  return input.sources.resolveRootBinding(sql, principal, { workspaceId, ...reference, source: root.source })
}

export async function resolveBoundRootPlacement(input: {
  sql: GraphSqlClient
  principal: ManagementPrincipal
  mainId: string
  workspaceId: string
  configuration: AgentConfigurationVersion
  root: SourceRootRecord
  roots: WorkspaceRootPolicyPort
  installations: HarnessInstallationRegistry
  qualificationSuites: Readonly<Record<CompatibilityHarness, string>>
  assertProfileReady?: (profile: HostHarnessOverride) => void
}): Promise<SavedNodePlacement> {
  const { sql, principal, mainId, workspaceId, configuration, root } = input
  const hostRef = root.selection.hostRef
  if (hostRef.mainId !== mainId || root.binding.workspaceId !== workspaceId) return unavailable('workflow_source_binding')
  const policy = await input.roots.resolve(sql, principal, { workspaceId, ...root.selection })
  const applicationInstallationId = root.registration?.workerInstallationId ?? mainId
  if (!sameWorkflowValue(policy.hostRef, hostRef) || !sameWorkflowValue(policy.registration, root.registration)
    || policy.applicationInstallationId !== applicationInstallationId) return unavailable('selected_root_policy')
  const profiles = await sql.query<{ record: unknown }>(`select settings.record from harness_instance_settings settings
    where settings.record#>>'{target,applicationInstallationId}'=$1
      and settings.record#>'{target,hostRef}'=$2::jsonb
      and not exists (select 1 from harness_instance_settings newer
        where newer.instance_id=settings.instance_id and newer.revision>settings.revision)
    for share of settings`, [applicationInstallationId, JSON.stringify(hostRef)])
  const installed = input.installations.list()
  const requested = configuration.harnessProfileSelection
  const candidates = profiles.rows.map(row => HostHarnessOverrideSchema.parse(row.record)).filter(profile =>
    profile.enabled
    && sameWorkflowValue(withAdvancedDefaults(profile.configuration), withAdvancedDefaults(configuration.harness))
    && (!requested || profile.instanceId === requested.instanceId && profile.instanceRevision === requested.instanceRevision))
  for (const candidate of candidates) input.assertProfileReady?.(candidate)
  const compatible = candidates.filter(profile => installed.some(item => item.installed
    && sameWorkflowValue(item.hostRef, hostRef) && item.harnessInstallationId === profile.target.harnessInstallationId
    && item.installationFingerprint === profile.target.installationFingerprint))
  const qualified = []
  for (const candidate of compatible) {
    const installation = installed.find(item => sameWorkflowValue(item.hostRef, hostRef)
      && item.harnessInstallationId === candidate.target.harnessInstallationId
      && item.installationFingerprint === candidate.target.installationFingerprint)!
    try {
      await readPlacementHarnessFacts(sql, { hostRef, payload: {
        kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
        driverId: candidate.driverId, driverRevision: installation.driverRevision,
        instanceId: candidate.instanceId, instanceRevision: candidate.instanceRevision,
        harnessInstallationId: installation.harnessInstallationId,
        installationFingerprint: candidate.target.installationFingerprint,
        runtimeContractVersion: 1, protocolRevision: installation.protocolRevision, credentialScopeRefs: [],
      } }, input.installations, input.qualificationSuites)
      qualified.push(candidate)
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'HARNESS_PROFILE_UNAVAILABLE') throw error
    }
  }
  if (qualified.length === 0 && compatible.length > 0) {
    throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'No compatible harness profile is qualified.', 409)
  }
  const profile = qualified[0]
  if (qualified.length !== 1 || !profile) return unavailable('selected_harness_profile')
  return SavedNodePlacementSchema.parse({
    schemaVersion: 1, hostRef, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision,
    locationRevision: policy.locationRevision, projectRoot: policy.canonicalProjectRoot,
    cwdPolicy: 'project-root', relativeCwd: '', instanceId: profile.instanceId,
    instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId,
    source: root.source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision },
  })
}
