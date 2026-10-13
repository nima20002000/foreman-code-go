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
    .toEqual([{ part: null, partition: null, files: [files[0], files[1]].sort(), expectedDurationMs: 330_000 }])
  expect(planIntegrationParts({ ...affected, files: [] }, { files, durations }, { host: 0, ordinary: 44 }))
    .toEqual([{ part: null, partition: null, files: [], expectedDurationMs: 0 }])
})

it('preserves separate host-only slices when hosts are busy and leaves ordinary work on cloud', () => {
  const hostFiles = [...userSystemdIntegrationFiles]
  const inventory = { files: [...files, ...hostFiles], durations }
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
  expect(parts).toHaveLength(10)
  expect(parts.every(part => part.expectedDurationMs === 330_000)).toBe(true)
})
