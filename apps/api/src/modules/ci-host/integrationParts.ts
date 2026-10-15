import { CI_MAX_RUN_TICKETS, integrationPartition, requiresUserSystemd, type CiDurations, type CiRunInput } from '@foreman-code/contracts'

export interface CiIntegrationInventory {
  files: string[]
  durations: CiDurations
}
export interface CiIntegrationSlots { host: number; ordinary: number }
const TARGET_TEST_MS = 240_000
const SETUP_MS = 90_000

/** Files measured at or above this run in separate slow-tier parts. */
export const SLOW_TEST_MS = 60_000

/** Keep systemd files on capable slices, then size ordinary work to four minutes per eligible slot.
 * Slow files have separate parts that can start alongside fast parts. */
export function planIntegrationParts(input: CiRunInput, inventory: CiIntegrationInventory, slots: CiIntegrationSlots) {
  const affected = (input.scope ?? 'affected') === 'affected' && input.files !== undefined
  const files = [...new Set(affected ? input.files : inventory.files)].sort()
  if (!files.length) return [{ part: null, partition: null, files: [], expectedDurationMs: 0, requiresBuildComputer: false }]
  const measured = files.map(file => inventory.durations[file]).filter((ms): ms is number => ms !== undefined)
    .sort((left, right) => left - right)
  const median = measured[Math.floor(measured.length / 2)] ?? 30_000
  const duration = (file: string) => inventory.durations[file] ?? median
  const slowFiles = files.filter(file => (inventory.durations[file] ?? 0) >= SLOW_TEST_MS)
  const fastFiles = files.filter(file => !slowFiles.includes(file))
  const tiers: { files: string[]; tier?: 'fast' | 'slow' }[] = slowFiles.length && fastFiles.length
    ? [{ files: fastFiles, tier: 'fast' }, { files: slowFiles, tier: 'slow' }] : [{ files }]
  const plans = tiers.map(({ files: tierFiles, tier }) => {
    const hostFiles = tierFiles.filter(requiresUserSystemd)
    const ordinary = tierFiles.filter(file => !requiresUserSystemd(file))
    const heavy = ordinary.filter(file => duration(file) >= TARGET_TEST_MS)
    const light = ordinary.filter(file => duration(file) < TARGET_TEST_MS)
    const wanted = heavy.length + Math.ceil(light.reduce((sum, file) => sum + duration(file), 0) / TARGET_TEST_MS)
    const hostCount = hostFiles.length ? Math.min(hostFiles.length, Math.max(1, slots.host)) : 0
    // Slow files each get their own part when slots allow, so the tier lasts as long as its slowest file.
    const ordinaryCount = ordinary.length ? Math.min(ordinary.length, Math.max(1, slots.ordinary - hostCount),
      Math.max(1, tier === 'slow' ? ordinary.length : wanted)) : 0
    const count = Math.min(64, input.partitions ?? 64, hostCount + ordinaryCount)
    return { tierFiles, tier, hostCount, ordinary, count }
  })
  let remaining = CI_MAX_RUN_TICKETS
  let wanted = plans.reduce((sum, plan) => sum + plan.count, 0)
  return plans.flatMap(({ tierFiles, tier, hostCount, ordinary, count: requested }) => {
    // Share the response budget across tiers while preserving each tier's partition limit.
    const count = Math.min(requested, Math.floor(remaining * requested / wanted))
    remaining -= count
    wanted -= requested
    const hostIndexes = Array.from({ length: Math.min(hostCount, count - Number(ordinary.length > 0)) }, (_, index) => index)
    return Array.from({ length: count }, (_, index) => {
      // Equal measured-work parts avoid historical host speed turning a small cloud part into a long host slice.
      const partition = count > 1 || tier ? { index, count, weights: Array(count).fill(1) as number[],
        targetDurationMs: TARGET_TEST_MS, ...(hostIndexes.length ? { hostIndexes } : {}),
        ...(tier ? { tier, slowFiles } : {}) } : null
      const slice = partition ? integrationPartition(files, inventory.durations, partition) : tierFiles
      return { part: null, partition, files: affected ? files : [],
        requiresBuildComputer: slice.some(requiresUserSystemd),
        expectedDurationMs: slice.length ? SETUP_MS + slice.reduce((sum, file) => sum + duration(file), 0) : 0 }
    })
  })
}
