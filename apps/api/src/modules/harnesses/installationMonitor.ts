import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import type pg from 'pg'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { commandInputHash } from '../commands/postgres.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { deviceBackpressured } from '../devices/deviceBusyError.js'
import { DomainError } from '../errors.js'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import { harnessHostKey } from './instanceSettings/repository.js'
import type { HostHarnessInstanceProfileChecks } from './instanceSettings/profileChecks.js'
import type { ProductionHarnessRegistry } from './productionRegistry.js'

function staleQualification(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(staleQualification)
  }
  return (error instanceof DomainError || error instanceof DeviceApplicationError)
    && ['HARNESS_INVENTORY_STALE', 'HARNESS_QUALIFICATION_TARGET_CHANGED'].includes(error.code)
}

/** Passive inventory changes schedule owned qualification; they never qualify an installation themselves. */
export class HarnessInstallationMonitor {
  private readonly stopping = new AbortController()
  private readonly generations = new Map<string, Map<string, string>>()
  private readonly workerSignals = new Map<string, AbortSignal>()
  private readonly hostRefreshes = new Map<string, Promise<boolean>>()
  private readonly backoffs = new Map<string, {
    failures: number; retryAt: number; operation: 'discovery' | 'qualification'
  }>()
  private mainHost: CanonicalMachineReference | undefined
  private timer: NodeJS.Timeout | undefined
  private refreshTask: Promise<void> | undefined
  constructor(private readonly registry: ProductionHarnessRegistry,
    private readonly checks: HostHarnessInstanceProfileChecks,
    private readonly endpoint: () => DeviceEndpoint,
    private readonly collectWorker: (binding: DeviceSessionBinding, inventory: unknown) => Promise<void>,
    private readonly qualifyMain: () => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly refreshIntervalMs = 5_000) {}

  start(mainId: string): void {
    this.mainHost = { kind: 'main', mainId }
    this.registry.observeInstallations((host, installationId) => this.changed(host, installationId))
    this.changed(this.mainHost, mainId)
    this.timer = setInterval(() => { void this.refresh().catch(this.report) }, this.refreshIntervalMs)
    this.timer.unref()
  }
  workerReady(binding: Readonly<DeviceSessionBinding>, signal: AbortSignal): void {
    this.workerSignals.set(binding.deviceId, signal)
    this.changed({ kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }, binding.workerInstallationId)
  }
  private generation(host: CanonicalMachineReference, driverId: string): string {
    const installations = this.registry.installations.list().filter(record =>
      harnessHostKey(record.hostRef) === harnessHostKey(host) && record.driverId === driverId)
    return commandInputHash(installations.map(record => ({
      id: record.harnessInstallationId, fingerprint: record.installationFingerprint,
      driver: record.driverId, driverRevision: record.driverRevision, protocol: record.protocolRevision,
      environment: record.environmentGeneration, connection: record.connectionGeneration, installed: record.installed,
    })))
  }
  private changed(host: CanonicalMachineReference, installationId: string): void {
    if (this.stopping.signal.aborted) return
    if (this.backingOff(host)) return
    const key = harnessHostKey(host)
    const previous = this.generations.get(key) ?? new Map<string, string>()
    const drivers = new Set([...previous.keys(), ...this.registry.installations.list()
      .filter(record => harnessHostKey(record.hostRef) === key).map(record => record.driverId)])
    for (const driverId of drivers) {
      const generation = this.generation(host, driverId)
      if (previous.get(driverId) === generation) continue
      if (this.recheck(host, installationId, driverId, generation)) previous.set(driverId, generation)
    }
    this.generations.set(key, previous)
  }
  private recheck(host: CanonicalMachineReference, installationId: string,
    driverId: string, generation: string): boolean {
    const endpoint = this.endpoint()
    const captured = host.kind === 'device' ? endpoint.captureRequest(host.deviceId, 'host-harness-check-v1') : undefined
    if (captured?.busy) return false
    const binding = captured?.binding
    if (host.kind === 'device' && !binding) return false
    const signal = AbortSignal.any([this.stopping.signal,
      ...(host.kind === 'device' && this.workerSignals.has(host.deviceId) ? [this.workerSignals.get(host.deviceId)!] : [])])
    const authorize = async (client: pg.PoolClient) => {
      signal.throwIfAborted()
      if (this.generation(host, driverId) !== generation) throw new DomainError(
        'HARNESS_INVENTORY_STALE', 'The harness installation changed during qualification.', 409)
      const registration = await assertDeviceHostInstallation(client, host, installationId)
      if (host.kind === 'device') {
        const current = endpoint.currentBinding(host.deviceId)
        if (!binding || !current || !registration || registration.keyRevision !== binding.keyRevision
          || registration.authorizationRevision !== binding.authorizationRevision
          || harnessConnectionGeneration(current) !== harnessConnectionGeneration(binding)) throw new DomainError(
          'HARNESS_INVENTORY_STALE', 'The Worker connection changed during qualification.', 409)
      }
    }
    void this.checks.recheckInstallation({ host, driverId, applicationInstallationId: installationId, generation,
      signal, authorize,
      installation: value => this.registry.currentInstallation(value),
      ...(host.kind === 'main' && driverId === 'codex' ? { beforeChecks: this.qualifyMain } : {}),
    }).then(() => {
      if (!this.backingOff(host)) this.succeeded(host, 'qualification')
    }).catch(error => {
      if (this.stopping.signal.aborted) return
      const generations = this.generations.get(harnessHostKey(host))
      const pressured = deviceBackpressured(error)
      if (pressured) this.backoff(host, 'qualification')
      if ((staleQualification(error) || pressured) && generations?.get(driverId) === generation) {
        // A stale check did not qualify this generation; let the next inventory refresh retry it.
        generations.delete(driverId)
      }
      this.report(error)
    })
    return true
  }
  refresh(): Promise<void> {
    this.stopping.signal.throwIfAborted()
    if (this.refreshTask) return this.refreshTask
    const task = this.collect()
    this.refreshTask = task
    const cleanup = () => { if (this.refreshTask === task) this.refreshTask = undefined }
    void task.then(cleanup, cleanup)
    return task
  }
  private async collect(): Promise<void> {
    const hosts = this.registry.installations.list().map(record => record.hostRef)
    if (this.mainHost) {
      hosts.push(this.mainHost)
      for (const [deviceId, signal] of this.workerSignals) {
        if (signal.aborted) continue
        hosts.push({ kind: 'device', mainId: this.mainHost.mainId, deviceId })
      }
    }
    try {
      await this.refreshHosts(hosts)
    } catch (error) {
      // Periodic discovery is best-effort; required-host callers receive the failure.
      if (!(error instanceof DomainError) || error.code !== 'HARNESS_INVENTORY_UNAVAILABLE') throw error
    }
  }
  async refreshHosts(hosts: readonly CanonicalMachineReference[], signal?: AbortSignal): Promise<void> {
    this.stopping.signal.throwIfAborted()
    signal?.throwIfAborted()
    const selected = new Map(hosts.map(host => [harnessHostKey(host), host]))
    const tasks = [...selected].map(([key, host]) => {
      const existing = this.hostRefreshes.get(key)
      if (existing) return existing
      const task = this.collectHost(host)
      this.hostRefreshes.set(key, task)
      const cleanup = () => { if (this.hostRefreshes.get(key) === task) this.hostRefreshes.delete(key) }
      void task.then(cleanup, cleanup)
      return task
    })
    const completed = Promise.all(tasks).then(refreshed => {
      if (refreshed.includes(false)) throw new DomainError('HARNESS_INVENTORY_UNAVAILABLE',
        'Harness installation inventory could not be refreshed on a required computer.', 503)
    })
    if (!signal) return completed
    return new Promise<void>((resolve, reject) => {
      const listener = addAbortListener(signal, () => reject(signal.reason))
      void completed.then(() => { listener[Symbol.dispose](); resolve() },
        error => { listener[Symbol.dispose](); reject(error) })
    })
  }
  private async collectHost(host: CanonicalMachineReference): Promise<boolean> {
    if (host.kind === 'main') {
      await this.registry.refreshMain(this.stopping.signal)
      return true
    }
    if (this.backingOff(host)) return false
    const captured = this.endpoint().captureRequest(host.deviceId, 'harness-discovery-v1')
    if (!captured || captured.busy) return false
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(30_000),
      ...(this.workerSignals.has(host.deviceId) ? [this.workerSignals.get(host.deviceId)!] : [])])
    try {
      const result = await captured.request({ operation: 'discover', refreshId: randomUUID() },
        { signal, priority: 'background' })
      signal.throwIfAborted()
      await this.collectWorker(captured.binding, result.payload)
      this.succeeded(host, 'discovery')
      return true
    } catch (error) {
      this.stopping.signal.throwIfAborted()
      if (deviceBackpressured(error)) this.backoff(host, 'discovery')
      this.report(error)
      return false
    }
  }
  private backingOff(host: CanonicalMachineReference): boolean {
    return Date.now() < (this.backoffs.get(harnessHostKey(host))?.retryAt ?? 0)
  }
  private backoff(host: CanonicalMachineReference, operation: 'discovery' | 'qualification'): void {
    const key = harnessHostKey(host)
    const failures = Math.min(5, (this.backoffs.get(key)?.failures ?? 0) + 1)
    this.backoffs.set(key, { failures, operation,
      retryAt: Date.now() + Math.min(300_000, 30_000 * 2 ** (failures - 1)) })
  }
  private succeeded(host: CanonicalMachineReference, operation: 'discovery' | 'qualification'): void {
    const key = harnessHostKey(host)
    if (this.backoffs.get(key)?.operation === operation) this.backoffs.delete(key)
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.registry.observeInstallations(undefined)
    this.stopping.abort(new Error('Harness installation monitoring is stopping.'))
    if (this.refreshTask) await Promise.allSettled([this.refreshTask])
    await Promise.allSettled([...this.hostRefreshes.values()])
  }
}
