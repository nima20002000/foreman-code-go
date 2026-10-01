import { HARNESS_PROFILE_CHECK_NAMESPACE, HostHarnessProfileCheckRequestSchema, HostHarnessProfileEvidenceSchema } from '@graphql/contracts/harness-registry'
import type { DeviceConnectionIdentity, CanonicalMachineReference } from '@graphql/contracts/device-identity'
import { harnessConnectionGeneration } from '../hostConnectionGeneration.js'
import { harnessHostKey } from './repository.js'
import type { HostHarnessProfileQualifier } from './profileChecks.js'

type ProfileBinding = Readonly<DeviceConnectionIdentity & { connectionEpoch: string }>

/** Advertise only with an actual admitted native qualifier; no incoming readiness flags are trusted. */
export function createHostHarnessProfileCheckExtension(options: {
  hostRef: Extract<CanonicalMachineReference, { kind: 'device' }>
  applicationInstallationId: string
  qualifierForBinding: (binding: ProfileBinding) => HostHarnessProfileQualifier
}) {
  const hostRef = { ...options.hostRef }, applicationInstallationId = options.applicationInstallationId
  const qualifierForBinding = options.qualifierForBinding
  return {
    namespace: HARNESS_PROFILE_CHECK_NAMESPACE, version: 1, role: 'server' as const, maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload: unknown, context: { binding: ProfileBinding; signal: AbortSignal }) {
      const input = HostHarnessProfileCheckRequestSchema.parse(payload)
      context.signal.throwIfAborted()
      if (context.binding.mainId !== hostRef.mainId || context.binding.deviceId !== hostRef.deviceId
        || context.binding.workerInstallationId !== applicationInstallationId
        || harnessHostKey(input.override.target.hostRef) !== harnessHostKey(hostRef)
        || input.override.target.applicationInstallationId !== applicationInstallationId) throw new Error('Native profile check host binding mismatch.')
      const expectedConnection = harnessConnectionGeneration(context.binding)
      const proof = HostHarnessProfileEvidenceSchema.parse(await qualifierForBinding(context.binding)
        .qualify(input.override, { checkId: input.checkId, signal: context.signal }))
      context.signal.throwIfAborted()
      if (proof.connectionGeneration !== expectedConnection || harnessHostKey(proof.target.hostRef) !== harnessHostKey(hostRef)
        || proof.target.applicationInstallationId !== applicationInstallationId || proof.target.harnessInstallationId !== input.override.target.harnessInstallationId
        || proof.target.installationFingerprint !== input.override.target.installationFingerprint
        || proof.instanceRevision !== input.override.instanceRevision || proof.configurationFingerprint !== input.override.configurationFingerprint
        || proof.driverId !== input.override.driverId) throw new Error('Native profile check returned stale or unrelated evidence.')
      return { payload: proof }
    },
  }
}
