import { describe, expect, it } from 'vitest'
import { integrationPartition } from '@foreman-code/contracts'

const files = Array.from({ length: 40 }, (_, index) => `apps/api/test/f${String(index).padStart(2, '0')}.integration.test.ts`)
const durations = Object.fromEntries(files.map((file, index) => [file, 1000 + index * 50]))
const work = (slice: string[]) => slice.reduce((total, file) => total + durations[file]!, 0)

describe('integration partitions', () => {
  it('gives a twice-as-fast computer about twice the work, and every file exactly once', () => {
    const weights = [2, 1]
    const slices = [0, 1].map(index => integrationPartition(files, durations, { index, count: 2, weights }))
    expect(slices.flat().sort()).toEqual(files)
    const ratio = work(slices[0]!) / work(slices[1]!)
    expect(ratio).toBeGreaterThan(1.8)
    expect(ratio).toBeLessThan(2.2)
    // Same inputs, same slices: every computer computes its own slice independently.
    expect(integrationPartition(files, durations, { index: 0, count: 2, weights })).toEqual(slices[0])
  })

  it('splits evenly without weights', () => {
    const slices = [0, 1, 2].map(index => integrationPartition(files, durations, { index, count: 3 }))
    const loads = slices.map(work)
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(2000)
  })

  it('isolates user-systemd files and balances ordinary files across cloud slices', () => {
    const systemd = [
      'apps/api/test/workflow-systemd-installed-service.integration.test.ts',
      'apps/api/test/workflow-systemd-active-recovery.integration.test.ts',
      'apps/api/test/workflow-systemd-writable-source-recovery.integration.test.ts',
      'apps/api/test/workflow-systemd-restart-unit-cleanup.integration.test.ts',
      'apps/api/test/workflow-systemd-restart-admitting-interval.integration.test.ts',
      'apps/api/test/workflow-systemd-restart-failed-admission.integration.test.ts',
      'apps/api/test/native-service-restart.integration.test.ts',
    ]
    const cloud = [
      'apps/api/test/workflow-systemd-restart.integration.test.ts',
      'apps/api/test/remote-review-production-main-crash.integration.test.ts',
      'apps/api/test/local-human-native.integration.test.ts',
    ]
    const selected = [...systemd, ...cloud, ...files]
    const slices = [0, 1, 2].map(index => integrationPartition(selected, durations,
      { index, count: 3, weights: [100, 2, 1], hostIndexes: [0] }))
    expect(slices.flat().sort()).toEqual([...selected].sort())
    expect(slices[0]).toEqual(systemd)
    expect(slices.slice(1).flat()).toEqual(expect.arrayContaining(cloud))
    expect(slices.slice(1).every(slice => slice.length > 0)).toBe(true)
    const loads = slices.slice(1).map(slice => work(slice.filter(file => files.includes(file))))
    expect(loads[0]! / loads[1]!).toBeGreaterThan(1.8)
    expect(loads[0]! / loads[1]!).toBeLessThan(2.2)
  })
})
