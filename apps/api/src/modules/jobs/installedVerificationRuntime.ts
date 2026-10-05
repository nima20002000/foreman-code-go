import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { JobVerificationRuntimeFingerprintSchema, JobVerificationInstalledRuntimeDescriptorSchema,
  type JobVerificationProfile, type JobQualificationCandidateRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../errors.js'
import { fingerprintQualificationPath, qualificationMountId } from './qualification.js'
import { readFile } from 'node:fs/promises'
import { readProtectedRuntimeConfiguration, type InstalledRuntimeConfigurationLocation,
  type InstalledRuntimeObservedHost } from './installedRuntimeHost.js'

const machine = z.object({ ...JobVerificationRuntimeFingerprintSchema.shape }).omit({
  schemaVersion: true, profileId: true, profileRevision: true, specDigest: true,
  hostRef: true, registration: true, mainInstallationId: true, root: true,
})
export const InstalledVerificationRuntimeConfigurationSchema = z.object({
  schemaVersion: z.literal(2), root: SourceRootRecordSchema,
  descriptor: JobVerificationInstalledRuntimeDescriptorSchema,
  machine,
  seedReceiptPath: z.string().startsWith('/').max(2048),
  seedReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  const { descriptor, machine } = value
  if (descriptor.runtimeExecutable !== machine.runtimeExecutable || descriptor.ociExecutable !== machine.ociExecutable
    || !isDeepStrictEqual(descriptor.resources, machine.resources)
    || !isDeepStrictEqual(descriptor.network, machine.network)
    || !isDeepStrictEqual(descriptor.approvalConfig, machine.approvalConfig)
    || value.seedReceiptSha256 !== machine.seedReceiptSha256) {
    context.addIssue({ code: 'custom', message: 'Protected descriptor and verification fingerprint must agree.' })
  }
})

export async function inspectInstalledVerificationRuntime(input: {
  configuration: InstalledRuntimeConfigurationLocation | null
  profile: JobVerificationProfile
  host: InstalledRuntimeObservedHost
}) {
  const configuration = await readProtectedRuntimeConfiguration(input.configuration,
    InstalledVerificationRuntimeConfigurationSchema)
  const { descriptor, machine: recorded } = configuration
  const profile = input.profile
  if (!isDeepStrictEqual(configuration.root, profile.root)
    || !isDeepStrictEqual(descriptor.target.hostRef, input.host.hostRef)
    || !isDeepStrictEqual(descriptor.target.registration, input.host.registration)
    || descriptor.target.mainInstallationId !== input.host.mainInstallationId
    || recorded.bootId !== bootIdentity() || recorded.bootId !== input.host.bootId
    || !isDeepStrictEqual(recorded.resources, profile.spec.resources)
    || !isDeepStrictEqual(recorded.approvalConfig, profile.approvalConfig)
    || !isDeepStrictEqual(recorded.network, profile.spec.policy.network)
    || recorded.seedReceiptSha256 !== configuration.seedReceiptSha256) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Protected verification installation differs from this profile.', 409)
  }
  const [runtime, oci, root] = await Promise.all([
    fingerprintQualificationPath(descriptor.runtimeExecutable, true),
    fingerprintQualificationPath(descriptor.ociExecutable, true),
    fingerprintQualificationPath(profile.root.binding.canonicalPath),
  ])
  if (runtime.sha256 !== recorded.runtimeBinarySha256 || oci.sha256 !== recorded.ociBinarySha256
    || root.device !== profile.root.binding.filesystem.device || root.inode !== profile.root.binding.filesystem.inode
    || qualificationMountId(root.path, await readFile('/proc/self/mountinfo', 'utf8')) !== profile.root.binding.filesystem.mountId) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Verification binary or source namespace changed.', 409)
  }
  const fingerprint = JobVerificationRuntimeFingerprintSchema.parse({ ...recorded,
    schemaVersion: 3, profileId: profile.id, profileRevision: profile.revision, specDigest: profile.specDigest,
    root: profile.root, ...descriptor.target })
  return { descriptor, fingerprint, configuration }
}

export async function inspectInstalledVerificationCandidate(input: {
  configuration: InstalledRuntimeConfigurationLocation | null
  candidate: JobQualificationCandidateRecord
  host: InstalledRuntimeObservedHost
}) {
  const candidate = input.candidate
  if (candidate.fingerprint.schemaVersion !== 3) throw new Error('Verification candidate required.')
  const configuration = await readProtectedRuntimeConfiguration(input.configuration,
    InstalledVerificationRuntimeConfigurationSchema)
  const observed = JobVerificationRuntimeFingerprintSchema.parse({ ...configuration.machine,
    schemaVersion: 3, profileId: candidate.fingerprint.profileId,
    profileRevision: candidate.fingerprint.profileRevision, specDigest: candidate.fingerprint.specDigest,
    root: configuration.root, ...configuration.descriptor.target })
  if (!isDeepStrictEqual(observed, candidate.fingerprint)
    || candidate.runtimeRoot !== configuration.descriptor.runtimeRoot
    || candidate.sourceParent !== configuration.root.binding.canonicalPath
    || candidate.findmntBinary !== configuration.descriptor.findmntExecutable
    || candidate.findmntBinarySha256 !== configuration.descriptor.findmntBinarySha256
    || !isDeepStrictEqual(candidate.controllerEnvironment, configuration.descriptor.controllerEnvironment)
    || !isDeepStrictEqual(observed.hostRef, input.host.hostRef)
    || !isDeepStrictEqual(observed.registration, input.host.registration)
    || observed.mainInstallationId !== input.host.mainInstallationId || observed.bootId !== input.host.bootId
    || bootIdentity() !== observed.bootId) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The original verification installation changed.', 409)
  }
  const [runtime, oci, root] = await Promise.all([
    fingerprintQualificationPath(observed.runtimeExecutable, true), fingerprintQualificationPath(observed.ociExecutable, true),
    fingerprintQualificationPath(observed.root.binding.canonicalPath),
  ])
  if (runtime.sha256 !== observed.runtimeBinarySha256 || oci.sha256 !== observed.ociBinarySha256
    || root.device !== observed.root.binding.filesystem.device || root.inode !== observed.root.binding.filesystem.inode
    || qualificationMountId(root.path, await readFile('/proc/self/mountinfo', 'utf8')) !== observed.root.binding.filesystem.mountId) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The original verification binaries or root changed.', 409)
  }
}
