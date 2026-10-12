import { useRef } from 'react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { TelemetryStorage } from '@foreman-code/contracts/resource-telemetry'
import { useComputerUtilization } from '../../shared/api/computerActivity'
import { metricView, sampleClock } from '../resource-telemetry/telemetryView'
import { useMonotonicElapsed } from '../resource-telemetry/useMonotonicElapsed'

/** How long the last current reading may stand in, dimmed, for a late refresh. */
const LAST_KNOWN_MS = 60_000

export interface ComputerReadings {
  /** Current values, or the last current ones while a refresh is late; null when unknown. */
  cpu: number | null
  memory: number | null
  storage: TelemetryStorage | null
  storageUsedPercent: number | null
  /** True when the value shown is the held last-known reading, not a current one. */
  stale: { cpu: boolean; memory: boolean; storage: boolean }
  reasons: { cpu: string; memory: string }
  pending: boolean
}

/** CPU, memory and disk of one computer from its live telemetry. */
export function useComputerReadings(target: DeviceProvisioningTarget, online: boolean): ComputerReadings {
  const query = useComputerUtilization(target, online)
  // A slow or failed refresh keeps the previous reading; its own deadline decides what is current.
  const received = online ? query.data : null
  const elapsed = useMonotonicElapsed(received?.receivedMonoMs)
  const result = received?.result
  const sample = result?.kind === 'sample' ? result.sample : undefined
  const age = elapsed + (received?.requestDurationMs ?? 0)
  const cpu = sample && metricView('CPU', sample, age)
  const memory = sample && metricView('RAM', sample, age)
  const cpuPercent = cpu?.status === 'fresh' && sample?.cpu.state === 'fresh' ? sample.cpu.value.hostCapacityPercent : null
  const memoryPercent = memory?.status === 'fresh' && sample?.memory.state === 'fresh'
    && sample.memory.value.totalBytes ? sample.memory.value.bytes / sample.memory.value.totalBytes * 100 : null
  const storage = sample?.storage && sample.presence === 'online'
    && sampleClock(sample, age).freshRemainingMs > 0 ? sample.storage : null
  // Between readings the values are the last current ones, marked stale, rather than flickering to empty.
  const now = Date.now(), last = useRef<{ cpu: number | null; memory: number | null; storage: TelemetryStorage | null; at: number }>(null)
  if (cpuPercent !== null || memoryPercent !== null || storage) last.current = { cpu: cpuPercent, memory: memoryPercent, storage, at: now }
  const held = online && last.current && now - last.current.at < LAST_KNOWN_MS ? last.current : null
  const shownStorage = storage ?? held?.storage ?? null
  return {
    cpu: cpuPercent ?? held?.cpu ?? null,
    memory: memoryPercent ?? held?.memory ?? null,
    storage: shownStorage,
    storageUsedPercent: shownStorage?.totalBytes
      ? (shownStorage.totalBytes - shownStorage.availableBytes) / shownStorage.totalBytes * 100 : null,
    stale: { cpu: cpuPercent === null, memory: memoryPercent === null, storage: !storage },
    reasons: { cpu: cpu?.statusLabel ?? 'Unavailable', memory: memory?.statusLabel ?? 'Unavailable' },
    pending: online && query.isPending,
  }
}
