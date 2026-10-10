import type pg from 'pg'
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
import type { HarnessInstanceSettingsRepository } from '../harnesses/instanceSettings/repository.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { PlacementChoiceDiscovery } from './choicesService.js'

type DiscoveryServices = {
  roots: WorkspaceRootPolicyPort
  sources: SourceAdmissionPort
  profiles: HarnessInstanceSettingsRepository
  registry: Pick<ProductionHarnessRegistry, 'installations' | 'profileEvidence'>
}

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

/** Metadata discovery uses the same persisted authorities as placement admission; it never probes or launches a host. */
export class ProductionPlacementChoiceDiscovery implements PlacementChoiceDiscovery {
  constructor(private readonly pool: pg.Pool, private readonly services: () => DiscoveryServices) {}

  async list(principal: ManagementPrincipal, input: NodePlacementChoicesInput): Promise<NodePlacementChoice[]> {
    const services = this.services()
    const sql = await this.pool.connect()
    try {
      await sql.query('begin')
      const row = (await sql.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id=$1 and workspace_id=$2',
        [input.agentConfigurationVersionId, input.workspaceId],
      )).rows[0]
      const configuration = AgentConfigurationVersionSchema.parse(row?.record)
      const roots = await this.sourceRoots(sql, input.workspaceId)
      const choices: NodePlacementChoice[] = []
      for (const root of roots) {
        try {
          // Location changes do not replace an existing host's approved source namespace.
          const policy = await services.roots.resolve(sql, principal, {
            workspaceId: input.workspaceId, ...root.selection,
          })
          await services.sources.resolveRootBinding(sql, principal, {
            workspaceId: input.workspaceId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, source: root.source,
          })
          const profiles = await services.profiles.list(policy.hostRef, policy.applicationInstallationId, sql)
          for (const profile of profiles.filter(value => matchesConfiguration(value, configuration))) {
            choices.push(await this.choice(sql, services, policy, root, profile))
          }
        } catch (error) {
          // A stale root or revoked host cannot authorize a choice on that computer.
          if (!(error instanceof DomainError) || ![403, 404, 409, 410].includes(error.status)) throw error
        }
      }
      await sql.query('commit')
      return choices
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally {
      sql.release()
    }
  }

  private async sourceRoots(sql: pg.PoolClient, workspaceId: string) {
    const rows = await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c
      join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
      where c.workspace_id=$1 order by c.root_id`, [workspaceId])
    return rows.rows.map(row => SourceRootRecordSchema.parse(row.record))
  }

  private async choice(sql: pg.PoolClient, services: DiscoveryServices, policy: WorkspaceRootPolicy,
    root: SourceRootRecord, profile: HostHarnessOverride): Promise<NodePlacementChoice> {
    const placement = SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: policy.hostRef,
      rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision,
      locationRevision: policy.locationRevision, projectRoot: policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: profile.instanceId,
      instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId,
      source: root.source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } })
    const installed = services.registry.installations.list().some(installation => installation.installed
      && sameWorkflowValue(installation.hostRef, policy.hostRef)
      && installation.harnessInstallationId === profile.target.harnessInstallationId
      && installation.installationFingerprint === profile.target.installationFingerprint)
    const supportedDriver = profile.driverId === 'codex'
      || profile.driverId === 'claude' && policy.hostRef.kind === 'main'
    const qualified = supportedDriver && installed && await services.registry.profileEvidence(profile, sql)
    let reason: string | null = null
    if (!supportedDriver) {
      reason = 'This harness does not support workflow execution on this computer.'
    } else if (!qualified) {
      reason = 'The matching harness profile needs qualification on this computer.'
    }
    const hostLabel = policy.hostRef.kind === 'main' ? 'Main' : `Computer ${policy.hostRef.deviceId}`
    return { id: commandInputHash(placement), label: `${hostLabel} · ${profile.driverId} · ${policy.canonicalProjectRoot}`,
      placement, availability: reason === null ? 'ready' : 'unavailable', reason }
  }
}
