import type pg from 'pg'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { ciDirectoryCleanupCandidates } from './directoryRetention.js'
import { CI_HOST_NAMESPACE, CI_HOST_START_PROTOCOL_VERSION, CiHostReplySchema,
  type CiHostReply, type CiHostRequest } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { CiMirrorInput } from './serviceTypes.js'
import type { HostCiRunner } from './runner.js'
import type { CloudCi } from './cloud.js'
import { DomainError } from '../errors.js'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { assertBuildComputerTarget } from '../settings/buildComputers.js'
import { DeviceAccessError } from '../devices/access.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { DeviceRequestPriority } from '@foreman-code/contracts/device-application'

const log = componentLogger('jobs')

interface DeviceRequests {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest?: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown,
    options?: { timeoutMs?: number; priority?: DeviceRequestPriority }): Promise<{ payload: unknown }>
}

/** Build-enabled paired computers that serve host CI now, Main itself through its local runner, and cloud CI services
 * on the workspace's public mirror. */
export class ProductionHostCiEndpoint implements HostCiEndpoint {
  private readonly cleanupAt = new Map<string, number>()
  private readonly cleanupPending = new Map<string, Promise<void>>()
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly devices: () => DeviceRequests | undefined, private readonly local: Pick<HostCiRunner, 'handle'>,
    private readonly clouds: CloudCi[] = []) {}

  async publishMirror(input: CiMirrorInput): Promise<void> {
    // Publication is shared by provider and slot; readiness remains a dispatch concern.
    await Promise.all(this.clouds.map(cloud => cloud.publishMirror(input)))
  }

  async computers(): Promise<HostCiComputer[]> {
    // Recovery sweeps make provider calls; planning and listing must not wait for them.
    for (const cloud of this.clouds) {
      void cloud.reconcile().catch(error => { log.warn({ operation: 'recover cloud CI tickets', err: error, provider: cloud.provider.id }, 'Cloud CI recovery sweep failed') })
    }
    const rows = (await this.pool.query<{ host_key: string; target: DeviceProvisioningTarget
      build_enabled: boolean; build_priority: number; build_allowance_percent: number }>(
      'select host_key,target,build_enabled,build_priority,build_allowance_percent from build_computer_preferences')).rows
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
        computers.push({ key: row.host_key, hostRef, label: 'Main computer', priority: row.build_priority,
          buildAllowancePercent: row.build_allowance_percent })
        continue
      }
      if (hostRef.kind !== 'device' || !hostRef.deviceId) continue
      if (!devices?.capabilities(hostRef.deviceId).some(value => value.namespace === CI_HOST_NAMESPACE && value.mainCanRequest)) continue
      computers.push({ key: row.host_key, hostRef, label: `Computer ${hostRef.deviceId.slice(0, 8)}`, priority: row.build_priority,
        buildAllowancePercent: row.build_allowance_percent })
    }
    return [...computers, ...this.clouds.flatMap(cloud => cloud.computers())]
      .sort((left, right) => right.priority - left.priority)
  }

  async request(computer: HostCiComputer, request: CiHostRequest,
    options?: { priority: DeviceRequestPriority }): Promise<CiHostReply> {
    if (request.operation === 'start' && computer.hostRef.kind !== 'cloud') {
      const saved = (await this.computers()).find(value => value.key === computer.key
        && JSON.stringify(value.hostRef) === JSON.stringify(computer.hostRef))
      if (!saved) {
        throw new DomainError('BUILD_COMPUTER_DISABLED', 'This computer is no longer available for builds.', 409)
      }
      request = { ...request, buildAllowancePercent: saved.buildAllowancePercent ?? 100 }
    }
    if (request.operation === 'start' && computer.hostRef.kind === 'device') {
      const status = await this.sendRequest(computer, { operation: 'status' }, { priority: 'foreground' })
      if (status.operation !== 'status') throw new DomainError('CI_HOST_REPLY_INVALID', 'Expected Worker CI status.', 502)
      if ((status.startProtocolVersion ?? 0) < CI_HOST_START_PROTOCOL_VERSION) {
        throw new DomainError('CI_HOST_PROTOCOL_UNSUPPORTED', status.reasons.join('; '), 409)
      }
      if (!status.ready) throw new DomainError('CI_HOST_BUSY', status.reasons.join('; '), 409)
    }
    const reply = await this.sendRequest(computer, request, options)
    if (reply.operation === 'status' && reply.cleanupSupported) {
      void this.cleanDirectories(computer).catch(error => {
        log.warn({ operation: 'clean retained CI directories', err: error, hostRef: computer.hostRef }, 'CI directory cleanup failed; next status will retry')
      })
    }
    return reply
  }

  private async cleanDirectories(computer: HostCiComputer): Promise<void> {
    const hostRef = { ...computer.hostRef }
    delete hostRef.slot
    const key = canonicalJson(hostRef)
    const pending = this.cleanupPending.get(key)
    if (pending) return pending
    const now = Date.now()
    if (now - (this.cleanupAt.get(key) ?? -Infinity) < 5 * 60_000) return
    const cleanup = (async () => {
      const runIds = await ciDirectoryCleanupCandidates(this.pool, { hostRef: computer.hostRef, label: computer.label }, now)
      for (let offset = 0; offset < runIds.length; offset += 1000) {
        const reply = await this.sendRequest(computer, { operation: 'status', cleanupRunIds: runIds.slice(offset, offset + 1000) })
        if (reply.operation !== 'status' || !reply.removedRunIds) throw new Error('Expected CI cleanup reply.')
      }
      this.cleanupAt.set(key, now)
    })()
    this.cleanupPending.set(key, cleanup)
    try { await cleanup }
    finally { this.cleanupPending.delete(key) }
  }

  private async sendRequest(computer: HostCiComputer, request: CiHostRequest,
    options?: { priority: DeviceRequestPriority }): Promise<CiHostReply> {
    if (computer.hostRef.kind === 'main') return this.local.handle(request)
    if (computer.hostRef.kind === 'cloud') {
      const cloud = this.clouds.find(value => value.provider.id === computer.hostRef.provider)
      if (!cloud) throw new Error('This cloud CI service is off.')
      return cloud.handle(request)
    }
    const devices = this.devices()
    if (!devices || !computer.hostRef.deviceId) throw new Error('The build computer is offline.')
    const priority = options?.priority ?? (request.operation === 'status' ? 'background' : 'foreground')
    const reply = await devices.request(computer.hostRef.deviceId, CI_HOST_NAMESPACE, request,
      { timeoutMs: 120_000, priority })
    const parsed = CiHostReplySchema.parse(reply.payload)
    if (parsed.operation === 'status' && (parsed.startProtocolVersion ?? 0) < CI_HOST_START_PROTOCOL_VERSION) {
      return { ...parsed, ready: false, reasons: [...parsed.reasons,
        'Worker CI start protocol is unsupported; update the Worker.'].slice(-10) }
    }
    return parsed
  }
}
