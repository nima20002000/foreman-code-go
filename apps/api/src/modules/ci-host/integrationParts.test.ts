import { expect, it } from 'vitest'
import { integrationPartition, userSystemdIntegrationFiles } from '@foreman-code/contracts'
import { planIntegrationParts } from './integrationParts.js'

const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/example-${index}.integration.test.ts`)
const durations = Object.fromEntries(files.map(file => [file, 120_000]))
const input = { suite: 'integration' as const, commandId: 'integration', scope: 'full' as const }

it('sizes full integration work to four minutes and reports setup plus measured duration', () => {
  const parts = planIntegrationParts(input, { files, durations }, { host: 2, ordinary: 44 })
  expect(parts).toHaveLength(10)
  const slices = parts.map(part => integrationPartition(files, durations, part.partition!))
  expect(slices.flat().sort()).toEqual([...files].sort())
  expect(slices.every(slice => slice.length === 2)).toBe(true)
  expect(parts.every(part => part.expectedDurationMs === 330_000)).toBe(true)
  expect(parts.every(part => part.files.length === 0)).toBe(true)
})

it('keeps long files alone and packs the remaining files longest first', () => {
  const selected = files.slice(0, 5)
  const measured = Object.fromEntries(selected.map((file, index) => [file, [600_000, 180_000, 120_000, 60_000, 60_000][index]!]))
  const parts = planIntegrationParts(input, { files: selected, durations: measured }, { host: 0, ordinary: 44 })
  const slices = parts.map(part => integrationPartition(selected, measured, part.partition!))
  expect(parts).toHaveLength(3)
  expect(slices[0]).toEqual([selected[0]])
  expect(slices[1]).toEqual([selected[1], selected[4]])
  expect(slices[2]).toEqual([selected[2], selected[3]])
  expect(parts.map(part => part.expectedDurationMs)).toEqual([690_000, 330_000, 270_000])
})

it.each([1, 3, 44])('bounds parts to %i available slots without losing work', ordinary => {
  const parts = planIntegrationParts(input, { files, durations }, { host: 0, ordinary })
  expect(parts).toHaveLength(Math.min(10, ordinary))
  const slices = parts.map(part => part.partition ? integrationPartition(files, durations, part.partition) : files)
  expect(slices.flat().sort()).toEqual([...files].sort())
})

it('bounds caller-requested partitions to free slots and selected files', () => {
  expect(planIntegrationParts({ ...input, partitions: 64 }, { files, durations }, { host: 0, ordinary: 3 })).toHaveLength(3)
  expect(planIntegrationParts({ ...input, partitions: 2 }, { files, durations }, { host: 0, ordinary: 44 })).toHaveLength(2)
  const affected = { ...input, scope: 'affected' as const, files: [files[0]!, files[0]!, files[1]!] }
  expect(planIntegrationParts(affected, { files, durations }, { host: 0, ordinary: 44 }))
    .toEqual([{ part: null, partition: null, files: [files[0], files[1]].sort(), expectedDurationMs: 330_000, requiresBuildComputer: false }])
  expect(planIntegrationParts({ ...affected, files: [] }, { files, durations }, { host: 0, ordinary: 44 }))
    .toEqual([{ part: null, partition: null, files: [], expectedDurationMs: 0, requiresBuildComputer: false }])
})

it('preserves separate host-only slices when hosts are busy and leaves ordinary work on cloud', () => {
  const hostFiles = [...userSystemdIntegrationFiles]
  // Every file is measured as slow here, so the request has one tier and keeps its host-only slices.
  const inventory = { files: [...files, ...hostFiles], durations: { ...durations,
    ...Object.fromEntries(hostFiles.map(file => [file, 120_000])) } }
  const parts = planIntegrationParts(input, inventory, { host: 0, ordinary: 44 })
  expect(parts).toHaveLength(11)
  expect(parts[0]!.partition!.hostIndexes).toEqual([0])
  const slices = parts.map(part => integrationPartition(inventory.files, durations, part.partition!))
  expect(slices[0]!.sort()).toEqual(hostFiles.sort())
  expect(slices.slice(1).flat().sort()).toEqual([...files].sort())
})

it('uses the measured median for unknown files and sizes runner-derived selections conservatively', () => {
  const parts = planIntegrationParts({ suite: 'integration', commandId: 'derived' },
    { files, durations: { [files[0]!]: 120_000 } }, { host: 0, ordinary: 44 })
  // The one measured slow file forms the deferred slow tier; unmeasured files are estimated at the median.
  const fast = parts.filter(part => !part.deferred)
  expect(fast).toHaveLength(10)
  expect(fast.every(part => part.expectedDurationMs <= 330_000)).toBe(true)
  expect(parts.filter(part => part.deferred)).toHaveLength(1)
})

it('runs slow files in a deferred tier that no fast part contains', () => {
  const quick = files.slice(0, 8)
  const slow = files.slice(8, 11)
  const measured = { ...Object.fromEntries(quick.map(file => [file, 20_000])),
    ...Object.fromEntries(slow.map(file => [file, 90_000])) }
  const parts = planIntegrationParts(input, { files: [...quick, ...slow], durations: measured }, { host: 0, ordinary: 44 })
  const slices = parts.map(part => integrationPartition([...quick, ...slow], measured, part.partition!))
  const fastSlices = slices.filter((_, index) => !parts[index]!.deferred)
  const slowSlices = slices.filter((_, index) => parts[index]!.deferred)
  expect(fastSlices.flat().sort()).toEqual([...quick].sort())
  expect(slowSlices.flat().sort()).toEqual([...slow].sort())
  // Each slow file gets its own part, so the slow tier lasts as long as its slowest file.
  expect(slowSlices.every(slice => slice.length === 1)).toBe(true)
  expect(parts.filter(part => part.deferred).every(part => part.partition?.tier === 'slow')).toBe(true)
})

it('keeps a request with only fast or only slow files in one tier', () => {
  const quick = Object.fromEntries(files.map(file => [file, 20_000]))
  expect(planIntegrationParts(input, { files, durations: quick }, { host: 0, ordinary: 44 })
    .some(part => part.deferred || part.partition?.tier)).toBe(false)
  expect(planIntegrationParts(input, { files, durations }, { host: 0, ordinary: 44 })
    .some(part => part.deferred || part.partition?.tier)).toBe(false)
})


it('allows a single ordinary full slice to run on cloud without changing host-only placement', () => {
  const single = planIntegrationParts(input, { files: [files[0]!], durations }, { host: 0, ordinary: 44 })
  expect(single[0]).toMatchObject({ partition: null, requiresBuildComputer: false, expectedDurationMs: 210_000 })
  const hostFile = [...userSystemdIntegrationFiles][0]!
  const host = planIntegrationParts(input, { files: [hostFile], durations: { [hostFile]: 120_000 } },
    { host: 1, ordinary: 44 })
  expect(host[0]).toMatchObject({ partition: null, requiresBuildComputer: true })
})
