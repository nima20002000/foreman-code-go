import type pg from 'pg'
import { CI_HOST_NAMESPACE, CiHostReplySchema, type CiHostRequest } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { HostCiRunner } from './runner.js'
import type { CloudCi } from './cloud.js'

interface DeviceRequests {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest?: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: { timeoutMs?: number }): Promise<{ payload: unknown }>
}

/** Build-enabled paired computers that serve host CI now, Main itself through its local runner, and cloud CI services
 * on the workspace's public mirror. */
export class ProductionHostCiEndpoint implements HostCiEndpoint {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly devices: () => DeviceRequests | undefined, private readonly local: HostCiRunner,
    private readonly mainPriority = 10, private readonly clouds: CloudCi[] = []) {}

  async computers(): Promise<HostCiComputer[]> {
    const rows = (await this.pool.query<{ host_key: string; target: { hostRef: HostCiComputer['hostRef'] }
      build_enabled: boolean; build_priority: number }>(
      'select host_key,target,build_enabled,build_priority from build_computer_preferences')).rows
    const devices = this.devices()
    const computers: HostCiComputer[] = []
    for (const row of rows) {
      const hostRef = row.target.hostRef
      if (!row.build_enabled || hostRef.kind !== 'device' || !hostRef.deviceId) continue
      if (!devices?.capabilities(hostRef.deviceId).some(value => value.namespace === CI_HOST_NAMESPACE && value.mainCanRequest)) continue
      computers.push({ key: row.host_key, hostRef, label: `Computer ${hostRef.deviceId.slice(0, 8)}`, priority: row.build_priority })
    }
    const main = rows.find(row => row.target.hostRef.kind === 'main')
    if (!main || main.build_enabled) {
      computers.push({ key: `${this.mainId}:main`, hostRef: { kind: 'main', mainId: this.mainId }, label: 'Main computer',
        priority: main?.build_priority ?? this.mainPriority })
    }
    return [...computers, ...this.clouds.flatMap(cloud => cloud.computers())]
  }

  async request(computer: HostCiComputer, request: CiHostRequest) {
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
