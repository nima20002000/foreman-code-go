import { randomUUID } from 'node:crypto'
import { SourceRootRecordSchema } from '@graphql/contracts/source-admission'
import { JobRuntimeProfileSchema } from '@graphql/contracts/job-runtime'
import { DeviceRegistrationSchema } from '@graphql/contracts/device-identity'
import { AutoJobDefinitionSpecSchema, jobPolicyRequirements } from '@graphql/contracts/jobs'
import type { JobComputerCandidate } from '../../src/modules/jobs/computerSelection.js'
import { buildComputerTarget } from '../../src/modules/settings/buildComputers.js'
import { jobSpec } from './jobFixture.js'

// Runtime readiness is an inventory fixture; these tests make no physical qualification claim.
export function buildComputerFixture(mainId: string, workspaceId: string, deviceId = randomUUID()) {
  const spec = jobSpec()
  const registration = DeviceRegistrationSchema.parse({ mainId, deviceId, workerInstallationId: randomUUID(),
    publicKeyFingerprint: '1'.repeat(64), keyRevision: 1, authorizationRevision: 1,
    status: 'paired', scopes: ['connect', 'heartbeat'] })
  const rootId = randomUUID()
  spec.target = { ...spec.target, mainId, mainInstallationId: mainId,
    hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { ...spec.target.destination, rootPolicyId: rootId, attestationId: randomUUID() } }
  spec.policy = { ...spec.policy, isolationPolicyId: randomUUID() }
  const root = SourceRootRecordSchema.parse({ version: 1,
    source: { approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId,
      manifestDigest: spec.source.manifestDigest },
    selection: { hostRef: spec.target.hostRef, rootPolicyId: rootId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId, workerInstallationId: registration.workerInstallationId,
      workspaceId, rootId, bindingRevision: 1, locationRevision: 1, canonicalPath: spec.target.destination.canonicalProjectRoot,
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write',
      snapshotId: spec.source.snapshotId, manifestDigest: spec.source.manifestDigest },
    ownerPrincipalId: 'fixture', authorizedByPrincipalId: 'fixture', registration: spec.target.registration,
    attestationId: spec.target.destination.attestationId, attestationDigest: spec.target.destination.attestationHash,
    boundAt: '2026-10-01T00:00:00.000Z' })
  const profile = JobRuntimeProfileSchema.parse({ schemaVersion: 1, id: spec.policy.isolationPolicyId,
    revision: 1, workspaceId, name: 'Fixture runtime', root, policy: spec.policy,
    limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 32, diskBytes: 8388608 },
    specDigest: '1'.repeat(64), status: 'unqualified', measurement: null,
    createdAt: root.boundAt, updatedAt: root.boundAt })
  const candidate: JobComputerCandidate = { spec, profile, ready: true, reasons: [],
    sourceReservation: { scopeId: `${mainId}:${deviceId}:${registration.workerInstallationId}:1:3`, reservedBytes: 2097152 } }
  const auto = AutoJobDefinitionSpecSchema.parse({ ...spec, target: { kind: 'auto' },
    policy: jobPolicyRequirements(spec.policy), limits: profile.limits })
  return { registration, candidate, auto, target: buildComputerTarget(spec.target) }
}
