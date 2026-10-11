import { isDeepStrictEqual } from 'node:util'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { PROVIDER_ACCOUNT_WORKER_NAMESPACE, ProviderAccountWorkerRequestSchema,
  ProviderAccountObservationSchema, ProviderAccountModelsSchema, ProviderAccountNativeAuthenticationObservationSchema,
  type ProviderAccountWorkerRequest } from '@foreman-code/contracts/provider-accounts'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'

type AccountRequest = ProviderAccountWorkerRequest['request']
type Target = ProviderAccountWorkerRequest['target']

/** Captures one advertised authenticated channel; reconnects cannot retarget an in-flight operation. */
export class ProviderAccountWorkerCarrier {
  constructor(private readonly endpoint: () => Pick<DeviceEndpoint, 'captureRequest'>,
    private readonly authorize: (principal: ManagementPrincipal, target: Target,
      request: AccountRequest) => Promise<void>) {}

  async request(principal: ManagementPrincipal, target: Target, request: AccountRequest) {
    if (target.hostRef.kind !== 'device') {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'A Worker operation requires its paired device.', 409)
    }
    await this.authorize(principal, target, request)
    const deviceId = target.hostRef.deviceId
    const channel = this.endpoint().captureRequest(deviceId, PROVIDER_ACCOUNT_WORKER_NAMESPACE)
    if (!channel) throw new DomainError('PROVIDER_ACCOUNT_WORKER_UNAVAILABLE',
      'The selected Worker is offline or has not advertised account operations.', 409)
    const captured = channel.binding
    const connection = DeviceConnectionIdentitySchema.parse({ mainId: captured.mainId, deviceId: captured.deviceId,
      workerInstallationId: captured.workerInstallationId, bootId: captured.bootId,
      keyRevision: captured.keyRevision, authorizationRevision: captured.authorizationRevision,
      connectionGeneration: captured.connectionGeneration })
    if (connection.mainId !== target.hostRef.mainId || connection.deviceId !== deviceId
      || connection.workerInstallationId !== target.applicationInstallationId
      || connection.keyRevision !== target.keyRevision
      || connection.authorizationRevision !== target.authorizationRevision) {
      throw new DomainError('PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT', 'The Worker installation or authority changed.', 409)
    }
    const binding = 'binding' in request ? request.binding : request.operation.binding
    if (!isDeepStrictEqual(binding.target, target)) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'This slot belongs to another target.', 409)
    }
    const input = ProviderAccountWorkerRequestSchema.parse({ version: 1, target, connection, request })
    const result = await channel.request(input)
    await this.authorize(principal, target, request)
    const current = this.endpoint().captureRequest(deviceId, PROVIDER_ACCOUNT_WORKER_NAMESPACE)
    if (!current || !isDeepStrictEqual(channel.binding, current.binding) || result.bytes !== undefined) {
      throw new DomainError('PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT', 'The original account channel is no longer current.', 409)
    }
    if (request.kind === 'status') {
      const observed = ProviderAccountObservationSchema.parse(result.payload)
      if (observed.bindingRevision !== binding.bindingRevision || observed.generation !== connection.connectionGeneration) {
        throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The Worker observation belongs to another binding.', 409)
      }
      return observed
    }
    if (request.kind === 'models') {
      const observed = ProviderAccountModelsSchema.parse(result.payload)
      if (!isDeepStrictEqual(observed.binding, binding) || observed.generation !== connection.connectionGeneration) {
        throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The Worker models belong to another binding.', 409)
      }
      return observed
    }
    const observed = ProviderAccountNativeAuthenticationObservationSchema.parse(result.payload)
    if (!isDeepStrictEqual(observed.binding, binding) || observed.operationId !== request.operation.id
      || observed.generation !== request.operation.generation
      || (request.kind === 'prepare' && request.operation.generation !== connection.connectionGeneration)) {
      throw new DomainError('PROVIDER_AUTHENTICATION_STALE', 'The Worker result belongs to another operation.', 409)
    }
    return observed
  }
}
