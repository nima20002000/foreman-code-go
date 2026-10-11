import type pg from 'pg'
import { CI_HOST_NAMESPACE, CiHostReplySchema, type CiHostRequest } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { HostCiRunner } from './runner.js'
import type { CloudCi } from './cloud.js'
import { DomainError } from '../errors.js'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { assertBuildComputerTarget } from '../settings/buildComputers.js'
import { DeviceAccessError } from '../devices/access.js'

interface DeviceRequests {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest?: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: { timeoutMs?: number }): Promise<{ payload: unknown }>
}

/** Build-enabled paired computers that serve host CI now, Main itself through its local runner, and cloud CI services
 * on the workspace's public mirror. */
export class ProductionHostCiEndpoint implements HostCiEndpoint {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly devices: () => DeviceRequests | undefined, private readonly local: Pick<HostCiRunner, 'handle'>,
    private readonly clouds: CloudCi[] = []) {}

  async computers(): Promise<HostCiComputer[]> {
    const rows = (await this.pool.query<{ host_key: string; target: DeviceProvisioningTarget
      build_enabled: boolean; build_priority: number }>(
      'select host_key,target,build_enabled,build_priority from build_computer_preferences')).rows
    const devices = this.devices()
    const computers: HostCiComputer[] = []
    for (const row of rows) {
      const hostRef = row.target.hostRef
      if (!row.build_enabled || hostRef.mainId !== this.mainId) continue
      try {
        await assertBuildComputerTarget(this.pool, row.target)
      } catch (error) {
        if (error instanceof DeviceAccessError
          || error instanceof DomainError && error.code === 'BUILD_COMPUTER_IDENTITY_CHANGED') continue
        throw error
      }
      if (hostRef.kind === 'main') {
        computers.push({ key: row.host_key, hostRef, label: 'Main computer', priority: row.build_priority })
        continue
      }
      if (hostRef.kind !== 'device' || !hostRef.deviceId) continue
      if (!devices?.capabilities(hostRef.deviceId).some(value => value.namespace === CI_HOST_NAMESPACE && value.mainCanRequest)) continue
      computers.push({ key: row.host_key, hostRef, label: `Computer ${hostRef.deviceId.slice(0, 8)}`, priority: row.build_priority })
    }
    return [...computers, ...this.clouds.flatMap(cloud => cloud.computers())]
      .sort((left, right) => right.priority - left.priority)
  }

  async request(computer: HostCiComputer, request: CiHostRequest) {
    if (request.operation === 'start' && computer.hostRef.kind !== 'cloud'
      && !(await this.computers()).some(value => value.key === computer.key
        && JSON.stringify(value.hostRef) === JSON.stringify(computer.hostRef))) {
      throw new DomainError('BUILD_COMPUTER_DISABLED', 'This computer is no longer available for builds.', 409)
    }
    if (computer.hostRef.kind === 'main') return this.local.handle(request)
    if (computer.hostRef.kind === 'cloud') {
      const cloud = this.clouds.find(value => value.provider.id === computer.hostRef.provider)
      if (!cloud) throw new Error('This cloud CI service is off.')
      return cloud.handle(request)
    }
    const devices = this.devices()
    if (!devices || !computer.hostRef.deviceId) throw new Error('The build computer is offline.')
    const reply = await devices.request(computer.hostRef.deviceId, CI_HOST_NAMESPACE, request, { timeoutMs: 120_000 })
    return CiHostReplySchema.parse(reply.payload)
  }
}
