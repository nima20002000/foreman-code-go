import { Cpu, MemoryStick } from 'lucide-react'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerUtilization } from '../../shared/api/computerActivity'
import { metricView } from '../resource-telemetry/telemetryView'
import { useMonotonicElapsed } from '../resource-telemetry/useMonotonicElapsed'

export function ComputerUtilization({ target, online }: { target: DeviceProvisioningTarget; online: boolean }) {
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
  return <div className="computer-utilization" aria-label="Computer utilization" aria-busy={online && query.isPending}>
    <UtilizationMetric label="CPU" value={cpuPercent} reason={cpu?.statusLabel ?? 'Unavailable'} icon={<Cpu size={13} />} />
    <UtilizationMetric label="Memory" value={memoryPercent} reason={memory?.statusLabel ?? 'Unavailable'}
      icon={<MemoryStick size={13} />} />
  </div>
}
function UtilizationMetric({ label, value, reason, icon }: {
  label: string; value: number | null; reason: string; icon: React.ReactNode
}) {
  const display = value === null ? '—' : `${Math.round(value)}%`
  return <span className="computer-metric" title={`${label}: ${value === null ? reason : display}`}>
    <span aria-hidden="true">{icon}</span>
    <span className="computer-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.min(100, Math.round(value))}
      aria-valuetext={value === null ? reason : display}>
      <span style={{ width: `${Math.min(100, value ?? 0)}%` }} />
    </span><span className="computer-metric-value">{display}</span>
  </span>
}
