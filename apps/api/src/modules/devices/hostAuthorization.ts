import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { DeviceRegistrationSchema, type CanonicalMachineReference } from '@graphql/contracts/device-identity'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DeviceAccessError } from './access.js'

/** Use the command's transaction so revocation cannot race a host-scoped settings mutation. */
export async function authorizeDeviceHost(client: Pick<pg.ClientBase, 'query'>, principal: ManagementPrincipal,
  action: 'harnesses:read' | 'harnesses:update', host: CanonicalMachineReference, applicationInstallationId: string): Promise<void> {
  requireAuthorization(await readLiveManagementPrincipal(client, principal.id), action)
  const main = await client.query<{ id: string }>('select id from application_installation where singleton=true for share')
  if (main.rows[0]?.id !== host.mainId) throw new DeviceAccessError('wrong_main')
  if (host.kind === 'main') {
    if (applicationInstallationId !== host.mainId) throw new DeviceAccessError('unauthorized')
    return
  }
  const device = await client.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2 for share', [host.deviceId, host.mainId])
  if (!device.rows[0]) throw new DeviceAccessError('unauthorized')
  const registration = DeviceRegistrationSchema.parse(device.rows[0].record)
  if (registration.status !== 'paired') throw new DeviceAccessError(registration.status === 'revoked' ? 'revoked' : 'unauthorized')
  if (registration.workerInstallationId !== applicationInstallationId) throw new DeviceAccessError('unauthorized')
}
