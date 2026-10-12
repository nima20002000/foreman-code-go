import { readHostHarnessMeasurements } from '../harnesses/qualification/repository.js'
import { HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema, HostHarnessInstallationSchema,
  PinnedHarnessSelectionSchema, type HostHarnessInstallationDto, type HostHarnessOverride,
  type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { z } from 'zod'
import { HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { QUALIFICATION_TARGET_PROFILE } from '../harnesses/qualification/profiles.js'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import { placementDigest } from './binding.js'
const QualificationIdentitySchema = z.object({
  schemaVersion: z.literal(1), selection: PinnedHarnessSelectionSchema,
  driverRevision: z.string(), protocolRevision: z.string(), suiteRevision: z.string(),
  environmentGeneration: z.string(), connectionGeneration: z.string(), launcher: z.string().nullable(),
  payloadFingerprints: z.array(z.object({ path: z.string(), fingerprint: z.string() }).strict()),
}).strict()

function measuredInstallationMatches(evidence: unknown, installation: HostHarnessInstallationDto, suiteRevision: string) {
  const parsed = z.object({ qualificationIdentity: QualificationIdentitySchema }).passthrough().safeParse(evidence)
  if (!parsed.success) return false
  const identity = parsed.data.qualificationIdentity
  const selection = identity.selection
  return selection.driverId === installation.driverId
    && selection.harnessInstallationId === installation.harnessInstallationId
    && selection.installationFingerprint === installation.installationFingerprint
    && sameWorkflowValue(selection.hostRef, installation.hostRef)
    && sameWorkflowValue(identity, {
      schemaVersion: 1, selection, driverRevision: installation.driverRevision,
      protocolRevision: installation.protocolRevision, suiteRevision,
      environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration,
      launcher: installation.launcher.resolvedLauncher, payloadFingerprints: installation.launcher.payloadFingerprints ?? [],
    })
}
/** Exact immutable instance revision and binary proof; never today's Agent head
 * or a baseline/ready boolean. Registry provides the current host file identity. */
export async function readPlacementHarnessFacts(sql: GraphSqlClient, placement: Pick<AcceptedNodePlacement, 'payload' | 'hostRef'>,
  installations: HarnessInstallationRegistry, suites: Readonly<Record<CompatibilityHarness, string>>,
  options?: { purpose: 'resident' }) {
  const unavailable = (reason: string): never => {
    throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Exact persisted host profile and native qualification are required.',
      409, { reason, hostKind: placement.hostRef.kind })
  }
  if (placement.payload.kind !== 'agent') unavailable('unsupported_payload')
  const payload = placement.payload as Extract<typeof placement.payload, { kind: 'agent' }>
  const pinnedProof = payload.profileProofDigest
  const values = await sql.query<{ record: unknown }>(`select record from harness_instance_settings
    where instance_id=$1 and record->>'instanceRevision'=$2
      and record#>>'{target,harnessInstallationId}'=$3 and record#>>'{target,installationFingerprint}'=$4
    order by revision desc ${pinnedProof ? '' : 'limit 1'} for share`,
  [payload.instanceId, payload.instanceRevision, payload.harnessInstallationId, payload.installationFingerprint])
  if (!values.rows.length) unavailable('profile_revision_missing')
  const candidates = values.rows.map(row => HostHarnessOverrideSchema.parse(row.record))
  let selected: { override: HostHarnessOverride; profileProof: HostHarnessProfileEvidence } | undefined
  for (const override of candidates) {
    const evidence = await sql.query<{ record: unknown }>(`select record from harness_instance_profile_evidence
      where instance_id=$1 and instance_revision=$2 order by created_at desc,check_id desc for share`,
    [override.instanceId, override.revision])
    const proofs = evidence.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record))
    const profileProof = payload.profileProofDigest
      ? proofs.find(proof => placementDigest(proof) === payload.profileProofDigest) : proofs[0]
    if (profileProof) {
      selected = { override, profileProof }
      break
    }
  }
  const { override, profileProof } = selected ?? unavailable('profile_check_missing')
  const installed = options?.purpose === 'resident'
    ? installations.residentInstallation(placement.hostRef, payload.harnessInstallationId, payload.installationFingerprint)
    : installations.list().find(record => record.harnessInstallationId === payload.harnessInstallationId
      && sameWorkflowValue(record.hostRef, placement.hostRef))
  if (!installed) unavailable('host_inventory_missing')
  const installation = HostHarnessInstallationSchema.parse(installed)
  // An authenticated surviving process keeps its original qualification across transport reconnection.
  const qualifiedInstallation = options?.purpose === 'resident'
    ? { ...installation, connectionGeneration: profileProof.connectionGeneration } : installation
  if (!override.enabled || override.instanceRevision !== payload.instanceRevision || !sameWorkflowValue(override.target.hostRef, placement.hostRef)
    || override.target.harnessInstallationId !== payload.harnessInstallationId || override.target.installationFingerprint !== payload.installationFingerprint
    || !sameWorkflowValue(profileProof.target, override.target) || profileProof.configurationFingerprint !== override.configurationFingerprint
    || profileProof.instanceRevision !== payload.instanceRevision || profileProof.driverId !== payload.driverId
    || profileProof.driverRevision !== payload.driverRevision || profileProof.protocolRevision !== payload.protocolRevision
    || profileProof.environmentGeneration !== installation.environmentGeneration || profileProof.connectionGeneration !== qualifiedInstallation.connectionGeneration
    || profileProof.authenticated !== true || profileProof.compatible !== true || !profileProof.qualified
    || installation.installationFingerprint !== payload.installationFingerprint || installation.driverId !== payload.driverId
    || installation.driverRevision !== payload.driverRevision || installation.protocolRevision !== payload.protocolRevision
    || !installation.installed) unavailable('profile_binding_changed')
  // Main's Claude has no binary suite; its exact-target profile check (above) is the native qualification.
  if (payload.driverId === 'claude' && placement.hostRef.kind === 'main') return { override, profileProof, installation, qualification: undefined }
  if (payload.driverId !== 'codex') unavailable('unsupported_driver')
  const harness = payload.driverId as CompatibilityHarness
  const binarySha256 = installation.launcher.payloadFingerprints?.find(item => item.path === installation.launcher.resolvedLauncher)?.fingerprint
  if (!binarySha256 || !suites[harness]) return unavailable('binary_identity_missing')
  let measuredQualification: unknown
  if (!installation.observedVersion
    || installation.hostRef.kind === 'main' && payload.qualificationDigest) {
    if (installation.hostRef.kind !== 'main' && options?.purpose !== 'resident') unavailable('worker_qualification_missing')
    // Passive discovery does not run --version. Use the completed native measurement
    // only when its full installation and live context still match.
    const measured = await readHostHarnessMeasurements(sql, harness, binarySha256, suites[harness])
    const matching = measured.filter(row => measuredInstallationMatches(row.evidence, qualifiedInstallation, suites[harness]))
      .sort((left, right) => Date.parse(right.qualification.checkedAt ?? right.qualification.startedAt ?? '1970-01-01T00:00:00Z')
        - Date.parse(left.qualification.checkedAt ?? left.qualification.startedAt ?? '1970-01-01T00:00:00Z'))
    // Saved Runs retain their accepted measurement when later checks qualify the same installation again.
    const latest = payload.qualificationDigest
      ? matching.find(row => placementDigest(row.qualification) === payload.qualificationDigest)?.qualification
      : matching[0]?.qualification
    if (!latest || latest.status !== 'qualified') return unavailable('main_qualification_identity_missing')
    installation.observedVersion = latest.version
    measuredQualification = latest
  }
  let selectedQualification = measuredQualification ?? profileProof.completedNativeQualification?.record
  if (!selectedQualification) {
    const rows = await sql.query<Record<string, unknown>>(`select * from harness_qualifications where harness=$1 and version=$2
      and binary_sha256=$3 and suite_revision=$4 and status='passed' order by checked_at desc limit 1 for share`,
    [payload.driverId, installation.observedVersion, binarySha256, suites[harness]])
    const row = rows.rows[0]
    if (!row) return unavailable('binary_qualification_missing')
    selectedQualification = { harness: row.harness, version: row.version,
      binarySha256: row.binary_sha256, suiteRevision: row.suite_revision, profile: row.profile, status: 'qualified',
      checks: row.checks, failureReason: row.failure_reason,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
      checkedAt: row.checked_at instanceof Date ? row.checked_at.toISOString() : row.checked_at }
  }
  const qualification = HarnessQualificationSchema.parse(selectedQualification)
  if (qualification.status !== 'qualified' || qualification.harness !== harness
    || qualification.binarySha256 !== binarySha256 || qualification.version !== installation.observedVersion
    || qualification.suiteRevision !== suites[harness]) return unavailable('binary_qualification_missing')
  if (qualification.profile !== QUALIFICATION_TARGET_PROFILE[harness] || !qualification.checkedAt || !qualification.checks.length || qualification.checks.some(check => !check.passed)) unavailable('qualification_checks_failed')
  if (payload.profileProofDigest && payload.profileProofDigest !== placementDigest(profileProof)
    || payload.qualificationDigest && payload.qualificationDigest !== placementDigest(qualification)) unavailable('accepted_qualification_changed')
  return { override, profileProof, installation, qualification }
}
