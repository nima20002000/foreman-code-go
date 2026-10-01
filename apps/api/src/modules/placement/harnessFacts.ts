import { HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema, HostHarnessInstallationSchema } from '@graphql/contracts/harness-registry'
import { HarnessQualificationSchema } from '@graphql/contracts/harness-qualification'
import type { AcceptedNodePlacement } from '@graphql/contracts/node-placement'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { QUALIFICATION_TARGET_PROFILE } from '../harnesses/qualification/profiles.js'
import type { CompatibilityHarness } from '@graphql/contracts'
import { placementDigest } from './binding.js'
const unavailable = (): never => { throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Exact persisted host profile and native qualification are required.', 409) }
/** Exact immutable instance revision and binary proof; never today's Agent head
 * or a baseline/ready boolean. Registry provides the current host file identity. */
export async function readPlacementHarnessFacts(sql: GraphSqlClient, placement: Pick<AcceptedNodePlacement, 'payload' | 'hostRef'>,
  installations: HarnessInstallationRegistry, suites: Readonly<Record<CompatibilityHarness, string>>) {
  if (placement.payload.kind !== 'agent') unavailable()
  const payload = placement.payload as Extract<typeof placement.payload, { kind: 'agent' }>
  const values = await sql.query<{ record: unknown }>(`select record from harness_instance_settings
    where instance_id=$1 and record->>'instanceRevision'=$2 for share`, [payload.instanceId, payload.instanceRevision])
  if (values.rows.length !== 1) unavailable()
  const override = HostHarnessOverrideSchema.parse(values.rows[0]?.record)
  const evidence = await sql.query<{ record: unknown }>(`select record from harness_instance_profile_evidence
    where instance_id=$1 and instance_revision=$2 order by created_at desc,check_id desc limit 1024 for share`, [override.instanceId, override.revision])
  const proofRecords = evidence.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record))
  const selectedProof = payload.profileProofDigest ? proofRecords.find(proof => placementDigest(proof) === payload.profileProofDigest) : proofRecords[0]
  const profileProof = selectedProof ?? unavailable()
  const installed = installations.list().find(record => record.harnessInstallationId === payload.harnessInstallationId && sameWorkflowValue(record.hostRef, placement.hostRef))
  if (!installed) unavailable()
  const installation = HostHarnessInstallationSchema.parse(installed)
  if (!override.enabled || override.instanceRevision !== payload.instanceRevision || !sameWorkflowValue(override.target.hostRef, placement.hostRef)
    || override.target.harnessInstallationId !== payload.harnessInstallationId || override.target.installationFingerprint !== payload.installationFingerprint
    || !sameWorkflowValue(profileProof.target, override.target) || profileProof.configurationFingerprint !== override.configurationFingerprint
    || profileProof.instanceRevision !== payload.instanceRevision || profileProof.driverId !== payload.driverId
    || profileProof.driverRevision !== payload.driverRevision || profileProof.protocolRevision !== payload.protocolRevision
    || profileProof.environmentGeneration !== installation.environmentGeneration || profileProof.connectionGeneration !== installation.connectionGeneration
    || profileProof.authenticated !== true || profileProof.compatible !== true || !profileProof.qualified
    || installation.installationFingerprint !== payload.installationFingerprint || installation.driverId !== payload.driverId
    || installation.driverRevision !== payload.driverRevision || installation.protocolRevision !== payload.protocolRevision
    || !installation.installed || !installation.observedVersion) unavailable()
  if (payload.driverId !== 'codex' && payload.driverId !== 'opencode') unavailable()
  const harness = payload.driverId as CompatibilityHarness
  const binarySha256 = installation.launcher.payloadFingerprints?.find(item => item.path === installation.launcher.resolvedLauncher)?.fingerprint
  if (!binarySha256 || !suites[harness]) unavailable()
  const rows = await sql.query<Record<string, unknown>>(`select * from harness_qualifications where harness=$1 and version=$2
    and binary_sha256=$3 and suite_revision=$4 and status='passed' order by checked_at desc limit 1 for share`,
    [payload.driverId, installation.observedVersion, binarySha256, suites[harness]])
  const row = rows.rows[0]
  if (!row) unavailable()
  const qualification = HarnessQualificationSchema.parse({ harness: row!.harness, version: row!.version,
    binarySha256: row!.binary_sha256, suiteRevision: row!.suite_revision, profile: row!.profile, status: 'qualified',
    checks: row!.checks, failureReason: row!.failure_reason,
    startedAt: row!.started_at instanceof Date ? row!.started_at.toISOString() : row!.started_at,
    checkedAt: row!.checked_at instanceof Date ? row!.checked_at.toISOString() : row!.checked_at })
  if (qualification.profile !== QUALIFICATION_TARGET_PROFILE[harness] || !qualification.checks.length || qualification.checks.some(check => !check.passed)) unavailable()
  if (payload.profileProofDigest && payload.profileProofDigest !== placementDigest(profileProof)
    || payload.qualificationDigest && payload.qualificationDigest !== placementDigest(qualification)) unavailable()
  return { override, profileProof, installation, qualification }
}
