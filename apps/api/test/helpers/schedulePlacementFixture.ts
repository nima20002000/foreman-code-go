import { randomUUID } from 'node:crypto'
import { SourceRootRecordSchema } from '@graphql/contracts/source-admission'
import { WorkspaceRootPolicySchema } from '@graphql/contracts/workspace-root-policies'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../../src/modules/harnesses/installationRegistry.js'
import { AgentPlacementProducer } from '../../src/modules/placement/agentProducer.js'
import type { SourceAdmissionPort } from '../../src/modules/sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../../src/modules/sources/rootPolicyPorts.js'
import type { Sch11Fixture } from './sch11Fixture.js'

/** Source/root host reads are synthetic. Workflow saves, instance selection,
 * producer rejection, schedule transactions and authentication remain real. */
export async function schedulePlacementFixture(f: Sch11Fixture) {
  const mainId = randomUUID()
  const rootId = randomUUID()
  const rootPolicyId = randomUUID()
  const digest = 'a'.repeat(64)
  const hostRef = { kind: 'main' as const, mainId }
  const selection = { hostRef, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' }
  const source = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: digest }
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId, rootPolicyRevision: '1',
    workspaceId: f.scope.workspaceId, hostRef, applicationInstallationId: mainId, registration: null,
    locationRevision: '1', ownerPrincipalId: f.writer.principal.id, allowedBaseId: randomUUID(),
    configurationRevision: '1', relativePath: '', accessMode: 'read-write', canonicalProjectRoot: f.projectRoot,
    filesystem, directoryIdentityHash: digest, managedRuntimeRoot: f.runtimeRoot,
    runtimeFilesystem: filesystem, attestationId: randomUUID(), attestationDigest: digest })
  const root = SourceRootRecordSchema.parse({ version: 1, source, selection,
    binding: { version: 1, mainId, deviceId: null, workerInstallationId: null,
      workspaceId: f.scope.workspaceId, rootId, bindingRevision: 1, locationRevision: 1,
      canonicalPath: f.projectRoot, filesystem, accessMode: 'exclusive-write',
      snapshotId: source.snapshotId, manifestDigest: digest },
    ownerPrincipalId: f.writer.principal.id, authorizedByPrincipalId: f.writer.principal.id,
    registration: null, attestationId: policy.attestationId, attestationDigest: digest,
    boundAt: '2030-01-07T09:00:00.000Z' })
  const configured = f.fixture.configurations.map((configuration) => ({
    instanceId: `instance-${configuration.agentId}`, instanceRevision: '1',
    driverId: configuration.harness.harness, enabled: true, configuration: configuration.harness,
  }))
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload(configured)
  const installations = new HarnessInstallationRegistry(instances)
  installations.refresh(configured.map((instance) => ({ hostRef,
    harnessInstallationId: `installation-${instance.instanceId}`, installationFingerprint: digest,
    driverId: instance.driverId, driverRevision: '1', protocolRevision: '1',
    environmentGeneration: '1', connectionGeneration: '1', installed: true,
    authenticated: true, compatible: true, qualified: true, observedVersion: 'synthetic',
    launcher: { requested: instance.driverId, resolvedLauncher: `/synthetic/${instance.driverId}`,
      fingerprint: digest, status: 'installed' as const, interpreter: null, diagnostics: [],
      environment: { generation: '1', provenance: 'systemd' as const, cwd: '/synthetic', path: '/synthetic' },
      checkedAt: '2030-01-07T09:00:00.000Z' },
  })))
  const workflow = await f.workflows.get(f.writer.principal, f.scope.workspaceId, f.scope.workflowId)
  const graph = structuredClone(f.fixture.version.definition)
  for (const node of graph.nodes) {
    if (node.kind === 'job') throw new Error('Placement fixture requires Agent nodes.')
    const instance = configured.find((item) => item.instanceId === `instance-${node.agentId}`)!
    node.placement = { schemaVersion: 1, ...selection, projectRoot: policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: instance.instanceId, instanceRevision: '1',
      harnessInstallationId: `installation-${instance.instanceId}`, source,
      rootBinding: { rootId, bindingRevision: 1 } }
  }
  await f.workflows.current.save(f.writer.principal, 'http', { ...f.scope, commandId: randomUUID(),
    executionSemanticsVersion: 3, expectedRevision: workflow.revision,
    expectedWorkflowVersionId: f.fixture.version.id, expectedLocationRevision: 1,
    expectedAgentConfigurationVersionIds: f.fixture.version.agentConfigurationVersionIds, graph })
  let unavailable: Error | undefined
  const sources = { resolveRootBinding: async () => {
    if (unavailable) throw unavailable
    return root
  } } as unknown as SourceAdmissionPort
  const roots = { resolve: async () => policy } as unknown as WorkspaceRootPolicyPort
  return {
    producer: new AgentPlacementProducer(f.database.pool, mainId, sources, roots, installations,
      { codex: 'codex-live-4', opencode: 'opencode-live-4' }),
    changeInstance: () => instances.reload(configured.map((instance, index) =>
      ({ ...instance, instanceRevision: index === 0 ? '2' : '1' }))),
    temporarilyUnavailable: (error: Error) => { unavailable = error },
  }
}
