import { withAdvancedDefaults, type AgentConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SavedNodePlacementSchema, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { DomainError } from '../errors.js'

const unavailable = (reason: string): never => {
  throw new DomainError('PLACEMENT_ADMISSION_CONFLICT',
    'Main requires an approved source and root and a matching qualified harness profile.', 409, { reason })
}

/** Resolve only existing authorized Main choices. Admission still validates their source,
 * root, installation and qualification through the same services as explicit placements. */
export async function resolveLocalMainPlacement(input: {
  sql: GraphSqlClient
  principal: ManagementPrincipal
  mainId: string
  workspaceId: string
  locationRevision: number
  configuration: AgentConfigurationVersion
  roots: WorkspaceRootPolicyPort
  installations: HarnessInstallationRegistry
}): Promise<SavedNodePlacement> {
  const { sql, principal, mainId, workspaceId, configuration } = input
  const hostRef = { kind: 'main' as const, mainId }
  const policies = (await input.roots.read(sql, principal, workspaceId)).filter(policy =>
    sameWorkflowValue(policy.hostRef, hostRef) && policy.locationRevision === String(input.locationRevision))
  const policy = policies[0]
  if (policies.length !== 1 || !policy || policy.registration !== null
    || policy.applicationInstallationId !== mainId) return unavailable('main_root_policy')
  const bindings = await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c
    join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
    where c.workspace_id=$1 and b.record->'selection'=$2::jsonb for share of c,b`, [workspaceId,
    JSON.stringify({ hostRef, rootPolicyId: policy.rootPolicyId,
      rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision })])
  const root = bindings.rows[0] && SourceRootRecordSchema.parse(bindings.rows[0].record)
  if (bindings.rows.length !== 1 || !root || root.binding.workspaceId !== workspaceId) {
    return unavailable('main_source_binding')
  }
  const profiles = await sql.query<{ record: unknown }>(`select settings.record from harness_instance_settings settings
    where settings.record#>>'{target,applicationInstallationId}'=$1
      and settings.record#>'{target,hostRef}'=$2::jsonb
      and not exists (select 1 from harness_instance_settings newer
        where newer.instance_id=settings.instance_id and newer.revision>settings.revision)
    for share of settings`, [mainId, JSON.stringify(hostRef)])
  const installed = input.installations.list()
  const requested = configuration.harnessProfileSelection
  const compatible = profiles.rows.map(row => HostHarnessOverrideSchema.parse(row.record)).filter(profile =>
    profile.enabled
    && sameWorkflowValue(withAdvancedDefaults(profile.configuration), withAdvancedDefaults(configuration.harness))
    && (!requested || profile.instanceId === requested.instanceId && profile.instanceRevision === requested.instanceRevision
      && sameWorkflowValue(profile.target, requested.target))
    && installed.some(item => item.installed && sameWorkflowValue(item.hostRef, hostRef)
      && item.harnessInstallationId === profile.target.harnessInstallationId
      && item.installationFingerprint === profile.target.installationFingerprint))
  const profile = compatible[0]
  if (compatible.length !== 1 || !profile) return unavailable('main_harness_profile')
  return SavedNodePlacementSchema.parse({
    schemaVersion: 1, hostRef, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision,
    locationRevision: policy.locationRevision, projectRoot: policy.canonicalProjectRoot,
    cwdPolicy: 'project-root', relativeCwd: '', instanceId: profile.instanceId,
    instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId,
    source: root.source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision },
  })
}
