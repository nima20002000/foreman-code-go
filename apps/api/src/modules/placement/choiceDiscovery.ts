import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { AgentConfigurationVersionSchema, withAdvancedDefaults, type AgentConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { NodePlacementChoice, NodePlacementChoicesInput } from '@foreman-code/contracts/placement-readback'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import { provisionPairedAgentRoots, type PairedRootServices } from './pairedRoots.js'
import type { PlacementChoiceDiscovery } from './choicesService.js'

type DiscoveryServices = PairedRootServices & {
  roots: WorkspaceRootPolicyPort
  sources: SourceAdmissionPort
}

type PlacementRootPolicy = Pick<WorkspaceRootPolicy, 'hostRef' | 'applicationInstallationId'
  | 'rootPolicyId' | 'rootPolicyRevision' | 'locationRevision' | 'canonicalProjectRoot'>

function matchesConfiguration(profile: HostHarnessOverride, configuration: AgentConfigurationVersion): boolean {
  const requested = configuration.harnessProfileSelection
  if (requested && (profile.instanceId !== requested.instanceId
    || profile.instanceRevision !== requested.instanceRevision || !sameWorkflowValue(profile.target, requested.target))) {
    return false
  }
  return profile.enabled && sameWorkflowValue(
    withAdvancedDefaults(profile.configuration), withAdvancedDefaults(configuration.harness),
  )
}

/** Discovery prepares paired storage through shared services and reuses placement admission authorities. */
export class ProductionPlacementChoiceDiscovery implements PlacementChoiceDiscovery {
  constructor(private readonly pool: pg.Pool, private readonly services: () => DiscoveryServices) {}

  async list(principal: ManagementPrincipal, input: NodePlacementChoicesInput,
    source: 'http' | 'mcp' = 'mcp'): Promise<NodePlacementChoice[]> {
    const services = this.services()
    const configuration = await withTransaction(this.pool, async sql => {
      const row = (await sql.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id=$1 and workspace_id=$2',
        [input.agentConfigurationVersionId, input.workspaceId],
      )).rows[0]
      return AgentConfigurationVersionSchema.parse(row?.record)
    })
    await provisionPairedAgentRoots(this.pool, services, principal, input.workspaceId, configuration,
      matchesConfiguration, source)
    return withTransaction(this.pool, async sql => {
      const roots = await this.sourceRoots(sql, input.workspaceId)
      const choices: NodePlacementChoice[] = []
      for (const root of roots) {
        let policy: PlacementRootPolicy = { ...root.selection,
          applicationInstallationId: root.binding.workerInstallationId ?? root.binding.mainId,
          canonicalProjectRoot: root.binding.canonicalPath }
        let rootUnavailableReason: string | null = null
        try {
          // Location changes do not replace an existing host's approved source namespace.
          policy = await services.roots.resolve(sql, principal, {
            workspaceId: input.workspaceId, ...root.selection,
          })
          await services.sources.resolveRootBinding(sql, principal, {
            workspaceId: input.workspaceId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, source: root.source,
          })
        } catch (error) {
          if (!(error instanceof DomainError) || ![403, 404, 409, 410].includes(error.status)) throw error
          rootUnavailableReason = error.code === 'SOURCE_UNAVAILABLE'
            ? 'The approved source was released. Approve and bind the source again.'
            : error.message
        }
        const profiles = await services.profiles.list(policy.hostRef, policy.applicationInstallationId, sql)
        for (const profile of profiles.filter(value => matchesConfiguration(value, configuration))) {
          choices.push(await this.choice(sql, services, policy, root, profile, rootUnavailableReason))
        }
      }
      return choices
    })
  }

  private async sourceRoots(sql: pg.PoolClient, workspaceId: string) {
    const rows = await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c
      join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
      where c.workspace_id=$1 order by c.root_id`, [workspaceId])
    return rows.rows.map(row => SourceRootRecordSchema.parse(row.record))
  }

  private async choice(sql: pg.PoolClient, services: DiscoveryServices, policy: PlacementRootPolicy,
    root: SourceRootRecord, profile: HostHarnessOverride, rootUnavailableReason: string | null): Promise<NodePlacementChoice> {
    const placement = SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: policy.hostRef,
      rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision,
      locationRevision: policy.locationRevision, projectRoot: policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: profile.instanceId,
      instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId,
      source: root.source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } })
    let reason = rootUnavailableReason
    if (reason === null) {
      const installed = services.registry.installations.list().some(installation => installation.installed
        && sameWorkflowValue(installation.hostRef, policy.hostRef)
        && installation.harnessInstallationId === profile.target.harnessInstallationId
        && installation.installationFingerprint === profile.target.installationFingerprint)
      const supportedDriver = profile.driverId === 'codex'
        || profile.driverId === 'claude' && policy.hostRef.kind === 'main'
      const qualified = supportedDriver && installed && await services.registry.profileEvidence(profile, sql)
      if (!supportedDriver) {
        reason = 'This harness does not support workflow execution on this computer.'
      } else if (!qualified) {
        reason = 'The matching harness profile needs qualification on this computer.'
      }
    }
    const hostLabel = policy.hostRef.kind === 'main' ? 'Main' : `Computer ${policy.hostRef.deviceId}`
    return { id: commandInputHash(placement), label: `${hostLabel} · ${profile.driverId} · ${policy.canonicalProjectRoot}`,
      placement, availability: reason === null ? 'ready' : 'unavailable', reason }
  }
}
