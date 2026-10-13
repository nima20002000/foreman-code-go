import { integrationPartition, requiresUserSystemd, type CiDurations, type CiRunInput } from '@foreman-code/contracts'

export interface CiIntegrationInventory {
  files: string[]
  durations: CiDurations
}
export interface CiIntegrationSlots { host: number; ordinary: number }
const TARGET_TEST_MS = 240_000
const SETUP_MS = 90_000

/** Keep the same host-only slices, then size ordinary work to four minutes per free slot. */
export function planIntegrationParts(input: CiRunInput, inventory: CiIntegrationInventory, slots: CiIntegrationSlots) {
  const affected = (input.scope ?? 'affected') === 'affected' && input.files !== undefined
  const files = [...new Set(affected ? input.files : inventory.files)].sort()
  if (!files.length) return [{ part: null, partition: null, files: [], expectedDurationMs: 0, requiresBuildComputer: false }]
  const measured = files.map(file => inventory.durations[file]).filter((ms): ms is number => ms !== undefined)
    .sort((left, right) => left - right)
  const median = measured[Math.floor(measured.length / 2)] ?? 30_000
  const duration = (file: string) => inventory.durations[file] ?? median
  const hostFiles = files.filter(requiresUserSystemd)
  const ordinary = files.filter(file => !requiresUserSystemd(file))
  const heavy = ordinary.filter(file => duration(file) >= TARGET_TEST_MS)
  const light = ordinary.filter(file => duration(file) < TARGET_TEST_MS)
  const wanted = heavy.length + Math.ceil(light.reduce((sum, file) => sum + duration(file), 0) / TARGET_TEST_MS)
  const hostCount = hostFiles.length ? Math.min(hostFiles.length, Math.max(1, slots.host)) : 0
  const ordinaryCount = ordinary.length ? Math.min(ordinary.length, Math.max(1, slots.ordinary), Math.max(1, wanted)) : 0
  const count = Math.min(64, input.partitions ?? 64, hostCount + ordinaryCount)
  const hostIndexes = Array.from({ length: Math.min(hostCount, count - Number(ordinary.length > 0)) }, (_, index) => index)
  return Array.from({ length: count }, (_, index) => {
    // Equal measured-work parts avoid historical host speed turning a small cloud part into a long host slice.
    const partition = count > 1 ? { index, count, weights: Array(count).fill(1) as number[],
      targetDurationMs: TARGET_TEST_MS, ...(hostIndexes.length ? { hostIndexes } : {}) } : null
    const slice = partition ? integrationPartition(files, inventory.durations, partition) : files
    return { part: null, partition, files: affected ? files : [],
      requiresBuildComputer: slice.some(requiresUserSystemd),
      expectedDurationMs: slice.length ? SETUP_MS + slice.reduce((sum, file) => sum + duration(file), 0) : 0 }
  })
}
