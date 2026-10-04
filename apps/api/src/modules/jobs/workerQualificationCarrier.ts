import { isDeepStrictEqual } from 'node:util'
import { JOB_RUNTIME_QUALIFICATION_EXTENSION, JobRuntimeQualificationRpcRequestSchema, JobRuntimeQualificationRpcResponseSchema,
  type JobRuntimeNativeAdmission, type JobQualificationCandidate } from '@foreman-code/contracts/job-runtime'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { inspectInstalledJobRuntime, type InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import { runInstalledJobRuntimeQualification } from './installedRuntimeQualification.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { DomainError } from '../errors.js'

/** All diagnostic processes and OCI objects stay on this original installed
 * worker. Only Main's exact persisted diagnostic admission authorizes entry. */
export function createWorkerQualificationExtension(input: {
  configuration: InstalledRuntimeConfigurationLocation
  pairing: WorkerPairingConfiguration; bootId: string
  currentBinding(): Readonly<DeviceSessionBinding>
  request(namespace: string, payload: unknown, options?: { signal?: AbortSignal }): Promise<{ payload: unknown; bytes?: Uint8Array }>
  journal(): Promise<RemoteOperationJournal>; registry: NativeProcessRegistry
  signal: AbortSignal
}): DeviceExtensionRegistration {
  const observed = () => {
    input.signal.throwIfAborted()
    const connection = input.currentBinding()
    if (connection.mainId !== input.pairing.mainId || connection.deviceId !== input.pairing.deviceId
      || connection.workerInstallationId !== input.pairing.workerInstallationId || connection.keyRevision !== input.pairing.keyRevision
      || connection.authorizationRevision !== input.pairing.authorizationRevision || connection.bootId !== input.bootId)
      throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The actual original installed diagnostic host changed.', 409)
    return { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
      registration: { workerInstallationId: connection.workerInstallationId, keyRevision: connection.keyRevision, authorizationRevision: connection.authorizationRevision },
      mainInstallationId: connection.mainId, bootId: connection.bootId, connection }
  }
  return { ...JOB_RUNTIME_QUALIFICATION_EXTENSION, role: 'duplex', async handle(raw, context) {
    const request = JobRuntimeQualificationRpcRequestSchema.parse(raw), host = observed()
    if (context.bytes !== undefined || !isDeepStrictEqual(host.connection, context.binding)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The diagnostic request is not on the original actual Main channel.', 403)
    const signal = AbortSignal.any([input.signal, context.signal])
    if (request.operation === 'inspect') {
      const inspected = await inspectInstalledJobRuntime({ configuration: input.configuration, profile: request.profile, host })
      if (!isDeepStrictEqual(observed(), host)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The installed diagnostic host changed during capture.', 409)
      return { payload: JobRuntimeQualificationRpcResponseSchema.parse({ version: 1, operation: 'inspect', ...inspected }) }
    }
    if (request.operation !== 'run' || !isDeepStrictEqual(request.admission.connection, host.connection)) throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The genuine persisted diagnostic admission is required.', 403)
    const assertAdmission = async (admission: JobRuntimeNativeAdmission, candidate: JobQualificationCandidate = request.candidate) => {
      signal.throwIfAborted()
      if (!isDeepStrictEqual(observed(), host) || !isDeepStrictEqual(admission, request.admission) || !isDeepStrictEqual(candidate, request.candidate))
        throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original diagnostic admission changed.', 403)
      const reply = await input.request(JOB_RUNTIME_QUALIFICATION_EXTENSION.namespace, { version: 1, operation: 'authorize', admission, candidate }, { signal })
      const approved = JobRuntimeQualificationRpcResponseSchema.parse(reply.payload)
      if (reply.bytes !== undefined || approved.operation !== 'authorize' || !isDeepStrictEqual(approved.admission, admission)
        || !isDeepStrictEqual(approved.candidate, candidate) || approved.approval.fingerprint !== admission.fingerprintDigest
        || approved.approval.expiresAt !== admission.expiresAt || !isDeepStrictEqual(observed(), host))
        throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original Main did not authorize this actual diagnostic.', 403)
      return approved.approval
    }
    await assertAdmission(request.admission)
    const result = await runInstalledJobRuntimeQualification({ configuration: input.configuration, admission: request.admission,
      candidate: request.candidate, host, journal: await input.journal(), registry: input.registry, signal,
      assertAdmission: admission => assertAdmission(admission).then(() => undefined),
      authority: {
        readApproval: async id => id === request.admission.approvalId ? assertAdmission(request.admission) : null,
        assertCurrent: candidate => assertAdmission(request.admission, candidate).then(() => undefined),
        async reserve() { throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'Native reservation must use the actual installed qualification owner.', 409) },
      },
    })
    if (!isDeepStrictEqual(observed(), host)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'The original measured diagnostic host changed.', 409)
    return { payload: JobRuntimeQualificationRpcResponseSchema.parse({ version: 1, operation: 'run', admission: request.admission, candidate: request.candidate, result }) }
  } }
}
