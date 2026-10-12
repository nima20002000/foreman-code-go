import { useRef } from 'react'
import { Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerUtilization } from '../../shared/api/computerActivity'
import { metricView, sampleClock } from '../resource-telemetry/telemetryView'
import { useMonotonicElapsed } from '../resource-telemetry/useMonotonicElapsed'

export function ComputerUtilization({ target, online, compact = false }: {
  target: DeviceProvisioningTarget; online: boolean | undefined; compact?: boolean
}) {
  const query = useComputerUtilization(target, online !== false)
  // A slow or failed refresh keeps the previous reading; its own deadline decides what is current.
  const received = online !== false ? query.data : null
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
  // Between readings the meters show the last current values, marked stale, rather than flickering to empty.
  const now = Date.now(), last = useRef<{ cpu: number | null; memory: number | null; storage: typeof storage; at: number }>(null)
  if (cpuPercent !== null || memoryPercent !== null || storage) last.current = { cpu: cpuPercent, memory: memoryPercent, storage, at: now }
  const held = online !== false && last.current && now - last.current.at < LAST_KNOWN_MS ? last.current : null
  const shown = { cpu: cpuPercent ?? held?.cpu ?? null, memory: memoryPercent ?? held?.memory ?? null, storage: storage ?? held?.storage ?? null }
  const shownStoragePercent = shown.storage?.totalBytes ? (shown.storage.totalBytes - shown.storage.availableBytes) / shown.storage.totalBytes * 100 : null
  return <div className="computer-utilization" data-compact={compact || undefined} aria-label="Computer utilization"
    aria-busy={online !== false && query.isPending}>
    <UtilizationMetric label="CPU" value={shown.cpu} stale={cpuPercent === null} reason={cpu?.statusLabel ?? 'Unavailable'} icon={<Cpu size={13} />} />
    <UtilizationMetric label="Memory" value={shown.memory} stale={memoryPercent === null} reason={memory?.statusLabel ?? 'Unavailable'}
      icon={<MemoryStick size={13} />} />
    <UtilizationMetric label="Disk" value={shown.storage && shownStoragePercent} stale={!storage} reason="Unavailable" icon={<HardDrive size={13} />}
      text={shown.storage ? `${formatStorage(shown.storage.availableBytes)} free` : undefined}
      detail={shown.storage ? `${formatStorage(shown.storage.availableBytes)} free of ${formatStorage(shown.storage.totalBytes)}` : undefined} />
  </div>
}
/** How long the last current reading may stand in, dimmed, for a late refresh. */
const LAST_KNOWN_MS = 60_000
const GIB = 1024 ** 3
/** df-style binary sizes; short enough for the sidebar. */
function formatStorage(bytes: number) {
  return bytes >= 1024 * GIB ? `${(bytes / 1024 / GIB).toFixed(1)}T` : bytes >= 10 * GIB ? `${Math.round(bytes / GIB)}G`
    : `${(bytes / GIB).toFixed(1)}G`
}
function UtilizationMetric({ label, value, stale, reason, icon, text, detail }: {
  label: string; value: number | null; stale: boolean; reason: string; icon: React.ReactNode; text?: string | undefined; detail?: string | undefined
}) {
  const display = value === null ? '—' : text ?? `${Math.round(value)}%`
  const known = value !== null && stale ? `Last known ${detail ?? display}` : detail ?? display
  return <span className="computer-metric" data-stale={value !== null && stale || undefined} title={`${label}: ${value === null ? reason : known}`}>
    <span aria-hidden="true">{icon}</span>
    <span className="computer-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.min(100, Math.round(value))}
      aria-valuetext={value === null ? reason : known}>
      <span style={{ width: `${Math.min(100, value ?? 0)}%` }} data-high={value !== null && value >= 90 || undefined} />
    </span><span className="computer-metric-value">{display}</span>
  </span>
}
