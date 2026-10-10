import { z } from 'zod'
import { OperatorChatSetupSchema, type OperatorChatSetup } from '@foreman-code/contracts'
import { HARNESS_PROFILE_CHECK_NAMESPACE, HostHarnessProfileCheckRequestSchema, HostHarnessProfileEvidenceSchema,
  HostHarnessConfigurationInspectionRequestSchema, type HostHarnessConfigurationInspectionRequest,
  type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { DeviceConnectionIdentity, CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { harnessConnectionGeneration } from '../hostConnectionGeneration.js'
import { isDeepStrictEqual } from 'node:util'
import type { HostHarnessProfileQualifier } from './profileChecks.js'

type ProfileBinding = Readonly<DeviceConnectionIdentity & { connectionEpoch: string }>
type ProfileContext = { binding: ProfileBinding; signal: AbortSignal }
const RequestSchema = z.union([HostHarnessConfigurationInspectionRequestSchema, HostHarnessProfileCheckRequestSchema])

/** Advertise only with an actual admitted native qualifier; no incoming readiness flags are trusted. */
export function createHostHarnessProfileCheckExtension(options: {
  hostRef: Extract<CanonicalMachineReference, { kind: 'device' }>
  applicationInstallationId: string
  qualifierForBinding: (binding: ProfileBinding) => HostHarnessProfileQualifier
  inspectConfiguration?: (input: HostHarnessConfigurationInspectionRequest,
    context: { binding: ProfileBinding; signal: AbortSignal }) => Promise<OperatorChatSetup>
}) {
  const hostRef = { ...options.hostRef }
  const applicationInstallationId = options.applicationInstallationId
  const qualifierForBinding = options.qualifierForBinding
  function handle(payload: z.infer<typeof HostHarnessProfileCheckRequestSchema>,
    context: ProfileContext): Promise<{ payload: HostHarnessProfileEvidence }>
  function handle(payload: HostHarnessConfigurationInspectionRequest,
    context: ProfileContext): Promise<{ payload: OperatorChatSetup }>
  function handle(payload: unknown,
    context: ProfileContext): Promise<{ payload: HostHarnessProfileEvidence | OperatorChatSetup }>
  async function handle(payload: unknown,
    context: ProfileContext): Promise<{ payload: HostHarnessProfileEvidence | OperatorChatSetup }> {
    const input = RequestSchema.parse(payload)
    context.signal.throwIfAborted()
    if (context.binding.mainId !== hostRef.mainId || context.binding.deviceId !== hostRef.deviceId
      || context.binding.workerInstallationId !== applicationInstallationId
      || !isDeepStrictEqual(input.override.target.hostRef, hostRef)
      || input.override.target.applicationInstallationId !== applicationInstallationId) {
      throw new Error('Native profile check host binding mismatch.')
    }
    const expectedConnection = harnessConnectionGeneration(context.binding)
    if ('operation' in input) {
      if (!options.inspectConfiguration) throw new Error('Native configuration inspection is unavailable.')
      if (input.proof.connectionGeneration !== expectedConnection) {
        throw new Error('Native configuration inspection profile belongs to a stale connection.')
      }
      const setup = OperatorChatSetupSchema.parse(await options.inspectConfiguration(input, context))
      context.signal.throwIfAborted()
      if (setup.harness !== 'claude' || setup.endpoint !== input.endpoint || setup.routing !== 'fixed') {
        throw new Error('Native configuration inspection returned an unrelated configuration.')
      }
      return { payload: setup }
    }
    const proof = HostHarnessProfileEvidenceSchema.parse(await qualifierForBinding(context.binding)
      .qualify(input.override, { checkId: input.checkId, signal: context.signal }))
    context.signal.throwIfAborted()
    if (proof.connectionGeneration !== expectedConnection || !isDeepStrictEqual(proof.target.hostRef, hostRef)
      || proof.target.applicationInstallationId !== applicationInstallationId
      || proof.target.harnessInstallationId !== input.override.target.harnessInstallationId
      || proof.target.installationFingerprint !== input.override.target.installationFingerprint
      || proof.instanceRevision !== input.override.instanceRevision
      || proof.configurationFingerprint !== input.override.configurationFingerprint || proof.driverId !== input.override.driverId) {
      throw new Error('Native profile check returned stale or unrelated evidence.')
    }
    return { payload: proof }
  }
  return {
    namespace: HARNESS_PROFILE_CHECK_NAMESPACE, version: 1, role: 'server' as const, maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    handle,
  }
}
