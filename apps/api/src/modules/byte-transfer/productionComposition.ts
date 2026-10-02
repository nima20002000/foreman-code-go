import { RSYNC_STAGE_EXTENSION } from '@graphql/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { DomainError } from '../errors.js'
import { createRsyncProductionBackend, type RsyncProductionInput } from './rsyncProduction.js'
import { ResumableByteTransferService } from './service.js'

/** Protected installation ports, never request fields. The canonical service is
 * also the durable quota owner; source/output authority must select its exact domain. */
export type ProductionRsyncProviders = Omit<RsyncProductionInput,
  'side' | 'current' | 'receiver' | 'quota' | 'resolveSource' | 'acknowledged' | 'quiescent'> & {
  receiver: ResumableByteTransferService
  resolveSource: NonNullable<RsyncProductionInput['resolveSource']>
  acknowledged: NonNullable<RsyncProductionInput['acknowledged']>
  quiescent: NonNullable<RsyncProductionInput['quiescent']>
}
export type ProductionMainRsyncProviders = ProductionRsyncProviders & {
  selection: NonNullable<RsyncProductionInput['selection']>
  peer: NonNullable<RsyncProductionInput['peer']>
}

/** Availability means complete trusted ports, not an installed/SSH qualification.
 * No default proof, new connection, process launch or cleanup loop is created here. */
export function createProductionRsyncComposition(input: {
  side: 'main' | 'worker'
  providers?: Partial<ProductionRsyncProviders> | undefined
  current(deviceId: string): Readonly<DeviceSessionBinding> | undefined
}) {
  const p = input.providers, missing: string[] = []
  if (!p?.stagingRoot) missing.push('protected stagingRoot')
  if (typeof p?.accepted?.intent !== 'function' || typeof p.accepted.authorize !== 'function') missing.push('accepted transfer authority')
  if (!(p?.receiver instanceof ResumableByteTransferService)) missing.push('canonical receiver/shared quota')
  if (typeof p?.resolveSource !== 'function') missing.push('original immutable source reader')
  if (typeof p?.acknowledged !== 'function') missing.push('canonical acknowledgement')
  if (typeof p?.quiescent !== 'function') missing.push('stopped-writer proof')
  if (input.side === 'main') {
    if (typeof p?.selection !== 'function') missing.push('explicit trusted selection')
    if (typeof p?.peer?.capture !== 'function') missing.push('existing W07 rsync control channel')
  }
  if (missing.length) return { kind: 'unavailable' as const, missing, extensions: [] as DeviceExtensionRegistration[],
    sender: () => { throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', `Selected rsync is missing: ${missing.join(', ')}.`, 409) } }
  const providers = p as ProductionRsyncProviders
  const backend = createRsyncProductionBackend({ ...providers, side: input.side, current: input.current,
    receiver: providers.receiver, quota: providers.receiver })
  const extension: DeviceExtensionRegistration = { ...RSYNC_STAGE_EXTENSION, role: input.side === 'main' ? 'client' : 'server',
    ...(input.side === 'worker' ? { handle: backend.handle } : {}) }
  return { kind: 'configured' as const, missing, extensions: [extension], backend, sender: backend.sender }
}
