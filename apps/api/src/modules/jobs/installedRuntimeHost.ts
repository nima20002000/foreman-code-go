import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { z } from 'zod'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { JOB_RUNTIME_WORKSPACE_LAYOUT, CurrentJobRuntimeFingerprintSchema, JobRuntimeFingerprintSchema, InstalledJobRuntimeDescriptorSchema, type CurrentJobRuntimeFingerprint, type JobRuntimeFingerprint, type JobRuntimeNativeAdmission, type JobRuntimeProfile, type JobQualificationCandidate } from '@foreman-code/contracts/job-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DomainError } from '../errors.js'
import { captureJobRuntimeConfiguration, createQualificationNativeOwner, fingerprintQualificationPath, qualificationMountId,
  type InstalledJobRuntimeDescriptor, type JobQualificationAuthority, type QualificationNativeOwner } from './qualification.js'
import type { OCIContainerOwnership } from './executorContainerOwner.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'
import type { JobSql } from './repository.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const path = z.string().startsWith('/').refine(value => !value.includes('\0') && !value.includes('\n'))
const target = JobRuntimeFingerprintSchema.shape
/** Installer/human protected configuration, never public profile save input.
 * Pins identify an installation; none of these fields grants qualification. */
export const InstalledJobRuntimeConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.object({ hostRef: target.hostRef, registration: target.registration, mainInstallationId: target.mainInstallationId }).strict(),
  root: SourceRootRecordSchema,
  runtimeExecutable: path, ociExecutable: path, findmntExecutable: path, runtimeRoot: path, backingFile: path,
  controllerEnvironment: z.object({ PATH: z.string().min(1), XDG_RUNTIME_DIR: path, LANG: z.literal('C.UTF-8') }).strict(),
  pins: z.object({ bootId: z.uuid(), runtimeBinarySha256: digest, ociBinarySha256: digest, findmntBinarySha256: digest,
    configurationDigest: digest, imageDigest: target.imageDigest, toolchainDigest: digest, diskBytes: z.number().int().positive() }).strict(),
}).strict()
export type InstalledJobRuntimeConfiguration = z.infer<typeof InstalledJobRuntimeConfigurationSchema>
export const InstalledJobRuntimeCaptureInputSchema = InstalledJobRuntimeConfigurationSchema.omit({ pins: true }).extend({
  imageDigest: target.imageDigest, toolchainDigest: digest, diskBytes: z.number().int().positive(),
}).strict()
export type InstalledJobRuntimeCaptureInput = z.infer<typeof InstalledJobRuntimeCaptureInputSchema>
export interface InstalledRuntimeConfigurationLocation { path: string; ownerUid: number }
export interface InstalledRuntimeHostDependencies {
  /** Existing application-installation/device authority, no provider inventory. */
  identity: JobSql
  configuration: InstalledRuntimeConfigurationLocation | null
  /** Current authenticated carrier state only; G1 must not perform network IO. */
  currentConnection?(sql: JobSql, profile: Parameters<InstalledJobRuntimeHost['descriptor']>[0]): Promise<DeviceSessionBinding | null>
  /** Existing admitted original operation supplies process/OCI ownership, not config principal IDs. */
  reserve(input: Parameters<InstalledJobRuntimeHost['reserveQualification']>[0]): Promise<{
    native: Pick<QualificationNativeOwner, 'reserveProcess' | 'spawnProcess' | 'readNativeExit' | 'stopProcess' | 'close'>
    ownership: OCIContainerOwnership
    authority: JobQualificationAuthority
  }>
}
const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
function unavailable(reason: string): never { throw new DomainError('JOB_RUNTIME_INSTALLATION_UNAVAILABLE', 'The selected job runtime has no current protected installed configuration.', 409, { reason }) }

/** Installer-only passive capture. The existing source binding and approved
 * image/toolchain remain inputs; binary, boot and configuration pins are read
 * from this host. Does not install, execute, approve or qualify anything. */
export async function captureInstalledRuntimeConfiguration(input: InstalledJobRuntimeCaptureInput): Promise<InstalledJobRuntimeConfiguration> {
  const parsed = InstalledJobRuntimeCaptureInputSchema.parse(input)
  const { imageDigest, toolchainDigest, diskBytes, ...installation } = parsed
  if (hash(installation.target.hostRef) !== hash(installation.root.selection.hostRef) ||
    hash(installation.target.registration) !== hash(installation.root.registration) ||
    installation.target.mainInstallationId !== installation.root.binding.mainId || installation.root.binding.accessMode !== 'exclusive-write') unavailable('root_context_changed')
  const [runtime, oci, findmnt, source] = await Promise.all([
    fingerprintQualificationPath(installation.runtimeExecutable, true), fingerprintQualificationPath(installation.ociExecutable, true),
    fingerprintQualificationPath(installation.findmntExecutable, true), fingerprintQualificationPath(installation.root.binding.canonicalPath),
  ])
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const mountId = qualificationMountId(source.path, await readFile('/proc/self/mountinfo', 'utf8'))
  if (source.device !== installation.root.binding.filesystem.device || source.inode !== installation.root.binding.filesystem.inode ||
    mountId !== installation.root.binding.filesystem.mountId) unavailable('passive_identity_changed')
  const configurationDigest = hash(await captureJobRuntimeConfiguration(installation.runtimeRoot, installation.controllerEnvironment, {
    findmntBinary: installation.findmntExecutable, findmntBinarySha256: findmnt.sha256!, backingFile: installation.backingFile, backingBytes: diskBytes,
  }))
  return InstalledJobRuntimeConfigurationSchema.parse({ ...installation, pins: { bootId,
    runtimeBinarySha256: runtime.sha256, ociBinarySha256: oci.sha256, findmntBinarySha256: findmnt.sha256,
    configurationDigest, imageDigest, toolchainDigest, diskBytes } })
}

/** Read only. No default paths, env, image, pin or readiness can be fabricated. */
export async function readInstalledRuntimeConfiguration(location: InstalledRuntimeConfigurationLocation | null): Promise<InstalledJobRuntimeConfiguration> {
  if (!location) unavailable('missing_configuration')
  if (!Number.isSafeInteger(location.ownerUid) || location.ownerUid < 0 || !location.path.startsWith('/')) unavailable('invalid_configuration_location')
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (await realpath(location.path) !== location.path) unavailable('configuration_retargeted')
    file = await open(location.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat()
    if (!before.isFile() || before.uid !== location.ownerUid || before.mode & 0o022 || before.nlink !== 1 || before.size > 65536) unavailable('configuration_not_protected')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) unavailable('configuration_changed')
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) unavailable('configuration_changed')
    return InstalledJobRuntimeConfigurationSchema.parse(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    if (error instanceof DomainError) throw error
    return unavailable('configuration_unavailable')
  } finally { await file?.close() }
}

async function installedIdentity(sql: JobSql, configuration: InstalledJobRuntimeConfiguration) {
  const selected = configuration.target
  const main = (await sql.query<{ id: string }>('select id from application_installation where singleton=true for share')).rows[0]
  if (!main || main.id !== selected.mainInstallationId || selected.hostRef.mainId !== main.id) unavailable('installation_changed')
  // Same canonical active identity facts as assertDeviceHostInstallation,
  // read through the existing GraphSqlClient facade rather than raw PG overloads.
  let pinned: InstalledJobRuntimeConfiguration['target']['registration'] = null
  if (selected.hostRef.kind === 'device') {
    const device = (await sql.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2 for share', [selected.hostRef.deviceId, main.id])).rows[0]
    if (!device) unavailable('registration_missing')
    const registration = DeviceRegistrationSchema.parse(device.record)
    if (registration.status !== 'paired' || registration.mainId !== main.id || registration.deviceId !== selected.hostRef.deviceId || registration.workerInstallationId !== selected.registration?.workerInstallationId) unavailable('installation_changed')
    pinned = { workerInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }
  }
  if (hash(pinned) !== hash(selected.registration)) unavailable('registration_changed')
}

type InstalledRuntimeProfileContext = Pick<JobRuntimeProfile, 'id' | 'revision' | 'specDigest' | 'root' | 'limits'> & {
  policy: Pick<JobRuntimeProfile['policy'], 'imageDigest' | 'toolchainDigest'>
}
async function inspectConfiguration(configuration: InstalledJobRuntimeConfiguration, profile: InstalledRuntimeProfileContext) {
    if (hash(configuration.root) !== hash(profile.root) || hash(configuration.target.hostRef) !== hash(profile.root.selection.hostRef) ||
      hash(configuration.target.registration) !== hash(profile.root.registration)) unavailable('root_context_changed')
    if (configuration.pins.imageDigest !== profile.policy.imageDigest || configuration.pins.toolchainDigest !== profile.policy.toolchainDigest || configuration.pins.diskBytes !== profile.limits.diskBytes) unavailable('pin_unavailable')
    try {
      const [runtime, oci, findmnt, source] = await Promise.all([
        fingerprintQualificationPath(configuration.runtimeExecutable, true), fingerprintQualificationPath(configuration.ociExecutable, true),
        fingerprintQualificationPath(configuration.findmntExecutable, true), fingerprintQualificationPath(profile.root.binding.canonicalPath),
      ])
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      const mountId = qualificationMountId(source.path, await readFile('/proc/self/mountinfo', 'utf8'))
      if (runtime.sha256 !== configuration.pins.runtimeBinarySha256 || oci.sha256 !== configuration.pins.ociBinarySha256 || findmnt.sha256 !== configuration.pins.findmntBinarySha256 || bootId !== configuration.pins.bootId ||
        source.device !== profile.root.binding.filesystem.device || source.inode !== profile.root.binding.filesystem.inode || mountId !== profile.root.binding.filesystem.mountId) unavailable('passive_identity_changed')
      const descriptor = InstalledJobRuntimeDescriptorSchema.parse({ target: configuration.target, runtimeExecutable: configuration.runtimeExecutable,
        ociExecutable: configuration.ociExecutable, findmntExecutable: configuration.findmntExecutable, findmntBinarySha256: configuration.pins.findmntBinarySha256, runtimeRoot: configuration.runtimeRoot,
        backingFile: configuration.backingFile, controllerEnvironment: configuration.controllerEnvironment })
      const configurationDigest = hash(await captureJobRuntimeConfiguration(configuration.runtimeRoot, configuration.controllerEnvironment, {
        findmntBinary: configuration.findmntExecutable, findmntBinarySha256: configuration.pins.findmntBinarySha256,
        backingFile: configuration.backingFile, backingBytes: configuration.pins.diskBytes,
      }))
      if (configurationDigest !== configuration.pins.configurationDigest) unavailable('configuration_fingerprint_changed')
      const fingerprint = CurrentJobRuntimeFingerprintSchema.parse({ schemaVersion: 1, workspaceLayout: JOB_RUNTIME_WORKSPACE_LAYOUT, profileId: profile.id, profileRevision: profile.revision, specDigest: profile.specDigest,
        ...configuration.target, root: profile.root, bootId, runtimeExecutable: runtime.path, runtimeBinarySha256: runtime.sha256,
        ociExecutable: oci.path, ociBinarySha256: oci.sha256, configurationDigest, imageDigest: configuration.pins.imageDigest,
        toolchainDigest: configuration.pins.toolchainDigest, limits: profile.limits })
      const snapshot = { configuration, descriptor, fingerprint }
      return snapshot
    } catch (error) { if (error instanceof DomainError) throw error; return unavailable('passive_evidence_unavailable') }
  }

/** Worker-local protected capture. Pairing and current authenticated connection
 * are supplied by the existing installed worker authority; no SQL facade. */
export type InstalledRuntimeObservedHost = Pick<JobRuntimeNativeAdmission, 'hostRef' | 'registration' | 'mainInstallationId' | 'bootId' | 'connection'>
function assertInstalledHost(configuration: InstalledJobRuntimeConfiguration, host: InstalledRuntimeObservedHost) {
  const target = configuration.target
  if (hash(target.hostRef) !== hash(host.hostRef) || hash(target.registration) !== hash(host.registration) ||
    target.mainInstallationId !== host.mainInstallationId || configuration.pins.bootId !== host.bootId) unavailable('installation_changed')
  if (target.hostRef.kind === 'device') {
    const binding = DeviceSessionBindingSchema.parse(host.connection)
    if (binding.mainId !== target.mainInstallationId || binding.deviceId !== target.hostRef.deviceId ||
      binding.workerInstallationId !== target.registration?.workerInstallationId || binding.keyRevision !== target.registration?.keyRevision ||
      binding.authorizationRevision !== target.registration?.authorizationRevision || binding.bootId !== host.bootId) unavailable('current_connection_changed')
  } else if (host.connection !== null || target.registration !== null) unavailable('installation_changed')
}
export async function inspectInstalledJobRuntime(input: {
  configuration: InstalledRuntimeConfigurationLocation | null
  profile: JobRuntimeProfile
  host: InstalledRuntimeObservedHost
}): Promise<{ descriptor: InstalledJobRuntimeDescriptor; fingerprint: CurrentJobRuntimeFingerprint }> {
  const configuration = await readInstalledRuntimeConfiguration(input.configuration)
  assertInstalledHost(configuration, input.host)
  const { descriptor, fingerprint } = await inspectConfiguration(configuration, input.profile)
  return { descriptor, fingerprint }
}

/** Recheck the genuine admitted candidate on its own physical host. The
 * projection contains existing fingerprint facts, never a synthetic profile. */
export async function inspectInstalledJobRuntimeCandidate(input: {
  configuration: InstalledRuntimeConfigurationLocation | null; candidate: JobQualificationCandidate; host: InstalledRuntimeObservedHost
}): Promise<void> {
  const candidate = input.candidate, original = candidate.fingerprint
  if (original.workspaceLayout !== JOB_RUNTIME_WORKSPACE_LAYOUT) unavailable('unsupported_workspace_layout')
  const configuration = await readInstalledRuntimeConfiguration(input.configuration)
  assertInstalledHost(configuration, input.host)
  const { descriptor, fingerprint } = await inspectConfiguration(configuration, { id: original.profileId, revision: original.profileRevision,
    specDigest: original.specDigest, root: original.root, limits: original.limits, policy: { imageDigest: original.imageDigest, toolchainDigest: original.toolchainDigest } })
  if (hash(fingerprint) !== hash(original) || candidate.findmntBinary !== descriptor.findmntExecutable ||
    candidate.findmntBinarySha256 !== descriptor.findmntBinarySha256 || candidate.backingFile !== descriptor.backingFile ||
    candidate.runtimeRoot !== descriptor.runtimeRoot || candidate.backingBytes !== original.limits.diskBytes ||
    hash(candidate.controllerEnvironment) !== hash(descriptor.controllerEnvironment)) unavailable('original_approval_context_changed')
}

export function createInstalledJobRuntimeHost(dependencies: InstalledRuntimeHostDependencies): InstalledJobRuntimeHost & {
  inspect(profile: Parameters<InstalledJobRuntimeHost['descriptor']>[0]): Promise<{ descriptor: InstalledJobRuntimeDescriptor; fingerprint: CurrentJobRuntimeFingerprint }>
} {
  const snapshots = new Map<string, { configuration: InstalledJobRuntimeConfiguration; descriptor: InstalledJobRuntimeDescriptor; fingerprint: CurrentJobRuntimeFingerprint }>()
  const key = (profile: InstalledRuntimeProfileContext) => `${profile.id}:${profile.revision}`
  async function current(sql: JobSql, profile: Parameters<InstalledJobRuntimeHost['descriptor']>[0]) {
    const configuration = await readInstalledRuntimeConfiguration(dependencies.configuration)
    await installedIdentity(sql, configuration)
    const snapshot = await inspectConfiguration(configuration, profile)
    snapshots.set(key(profile), snapshot)
    return snapshot
  }
  return {
    async inspect(profile) { const { descriptor, fingerprint } = await current(dependencies.identity, profile); return { descriptor, fingerprint } },
    async descriptor(profile) { return (await current(dependencies.identity, profile)).descriptor },
    async currentConnection(sql, profile) {
      if (profile.root.selection.hostRef.kind === 'main') return null
      const snapshot = snapshots.get(key(profile))
      if (!snapshot || !dependencies.currentConnection) unavailable('current_connection_unavailable')
      const binding = DeviceSessionBindingSchema.parse(await dependencies.currentConnection(sql, profile))
      const selected = snapshot.configuration.target
      if (selected.hostRef.kind !== 'device' || binding.mainId !== selected.mainInstallationId || binding.deviceId !== selected.hostRef.deviceId ||
        binding.workerInstallationId !== selected.registration?.workerInstallationId || binding.keyRevision !== selected.registration?.keyRevision ||
        binding.authorizationRevision !== selected.registration?.authorizationRevision || binding.bootId !== snapshot.fingerprint.bootId) unavailable('current_connection_changed')
      return binding
    },
    async currentMetadata(sql, profile): Promise<JobRuntimeFingerprint | null> {
      // G1/GET readback consumes captured installed metadata only. Native entry
      // captures pins again; an uncaptured/restarted host never invents readiness.
      const snapshot = snapshots.get(key(profile))
      if (!snapshot || snapshot.fingerprint.profileRevision !== profile.revision || snapshot.fingerprint.specDigest !== profile.specDigest ||
        hash(snapshot.configuration.root) !== hash(profile.root) || snapshot.fingerprint.imageDigest !== profile.policy.imageDigest ||
        snapshot.fingerprint.toolchainDigest !== profile.policy.toolchainDigest || hash(snapshot.fingerprint.limits) !== hash(profile.limits)) return null
      try { await installedIdentity(sql, snapshot.configuration); return CurrentJobRuntimeFingerprintSchema.parse(snapshot.fingerprint) }
      catch (error) { if (error instanceof DomainError && error.status < 500) return null; throw error }
    },
    async reserveQualification(input) {
      input.signal.throwIfAborted()
      await input.assertAdmission()
      if (input.candidate.fingerprint.workspaceLayout !== JOB_RUNTIME_WORKSPACE_LAYOUT || input.approval.fingerprint.workspaceLayout !== JOB_RUNTIME_WORKSPACE_LAYOUT) unavailable('unsupported_workspace_layout')
      const { fingerprint } = await current(dependencies.identity, input.profile)
      if (input.operationId !== input.approval.qualificationId || input.candidate.operationId !== input.operationId || input.candidate.approvalId !== input.approval.id ||
        hash(fingerprint) !== input.approval.fingerprintDigest || hash(input.candidate.fingerprint) !== hash(fingerprint)) unavailable('original_approval_context_changed')
      const admitted = await dependencies.reserve(input)
      if (admitted.ownership.scope.subject.kind !== 'qualification' || admitted.ownership.scope.subject.qualificationId !== input.approval.qualificationId ||
        admitted.ownership.scope.subject.profileId !== input.profile.id || admitted.ownership.scope.subject.profileRevision !== input.profile.revision ||
        admitted.ownership.scope.subject.operationId !== input.operationId || admitted.ownership.scope.subject.fingerprint !== input.approval.fingerprintDigest ||
        admitted.ownership.scope.bootId !== fingerprint.bootId || !('admission' in admitted.ownership.scope) ||
        hash(admitted.ownership.scope.admission) !== hash(input.nativeAdmission)) unavailable('original_native_owner_changed')
      return createQualificationNativeOwner(input.candidate, admitted.native, admitted.ownership, admitted.authority)
    },
  }
}
