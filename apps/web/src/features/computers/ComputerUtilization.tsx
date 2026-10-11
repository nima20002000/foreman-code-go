import { Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerUtilization } from '../../shared/api/computerActivity'
import { metricView, sampleClock } from '../resource-telemetry/telemetryView'
import { useMonotonicElapsed } from '../resource-telemetry/useMonotonicElapsed'

export function ComputerUtilization({ target, online, compact = false }: {
  target: DeviceProvisioningTarget; online: boolean; compact?: boolean
}) {
  const query = useComputerUtilization(target, online)
  const received = online && !query.isError ? query.data : null
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
  const storagePercent = storage?.totalBytes ? (storage.totalBytes - storage.availableBytes) / storage.totalBytes * 100 : null
  return <div className="computer-utilization" data-compact={compact || undefined} aria-label="Computer utilization"
    aria-busy={online && query.isPending}>
    <UtilizationMetric label="CPU" value={cpuPercent} reason={cpu?.statusLabel ?? 'Unavailable'} icon={<Cpu size={13} />} />
    <UtilizationMetric label="Memory" value={memoryPercent} reason={memory?.statusLabel ?? 'Unavailable'}
      icon={<MemoryStick size={13} />} />
    <UtilizationMetric label="Disk" value={storage && storagePercent} reason="Unavailable" icon={<HardDrive size={13} />}
      text={storage ? `${formatStorage(storage.availableBytes)} free` : undefined}
      detail={storage ? `${formatStorage(storage.availableBytes)} free of ${formatStorage(storage.totalBytes)}` : undefined} />
  </div>
}
const GIB = 1024 ** 3
/** df-style binary sizes; short enough for the sidebar. */
function formatStorage(bytes: number) {
  return bytes >= 1024 * GIB ? `${(bytes / 1024 / GIB).toFixed(1)}T` : bytes >= 10 * GIB ? `${Math.round(bytes / GIB)}G`
    : `${(bytes / GIB).toFixed(1)}G`
}
function UtilizationMetric({ label, value, reason, icon, text, detail }: {
  label: string; value: number | null; reason: string; icon: React.ReactNode; text?: string | undefined; detail?: string | undefined
}) {
  const display = value === null ? '—' : text ?? `${Math.round(value)}%`
  return <span className="computer-metric" title={`${label}: ${value === null ? reason : detail ?? display}`}>
    <span aria-hidden="true">{icon}</span>
    <span className="computer-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.min(100, Math.round(value))}
      aria-valuetext={value === null ? reason : detail ?? display}>
      <span style={{ width: `${Math.min(100, value ?? 0)}%` }} data-high={value !== null && value >= 90 || undefined} />
    </span><span className="computer-metric-value">{display}</span>
  </span>
}
