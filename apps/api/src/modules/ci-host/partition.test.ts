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
})
