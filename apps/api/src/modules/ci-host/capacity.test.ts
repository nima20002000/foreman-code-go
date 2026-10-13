import { expect, it } from 'vitest'
import { hostCiCapacity } from './capacity.js'

const machine = { cpuCount: 16, memoryBytes: 32 * 2 ** 30, availableMemoryBytes: 24 * 2 ** 30 }

it('budgets two slots on a sixteen-core computer and accounts for existing reservations', () => {
  const first = hostCiCapacity(machine)
  expect(first).toMatchObject({ slotsUsed: 0, slotsTotal: 2, cpuCount: 8, memoryBytes: 12 * 2 ** 30 })
  const second = hostCiCapacity(machine, [first])
  expect(second).toMatchObject({ slotsUsed: 1, slotsTotal: 2, cpuCount: 8 })
  expect(hostCiCapacity(machine, [first, second])).toMatchObject({ slotsUsed: 2, slotsTotal: 2 })
})

it('bounds slots by available memory and keeps one slot for a small computer', () => {
  expect(hostCiCapacity({ ...machine, availableMemoryBytes: 7 * 2 ** 30 })).toMatchObject({ slotsTotal: 1 })
  expect(hostCiCapacity({ cpuCount: 2, memoryBytes: 4 * 2 ** 30, availableMemoryBytes: 2 * 2 ** 30 }))
    .toMatchObject({ slotsTotal: 1, slotsUsed: 0, cpuCount: 2, memoryBytes: 2 * 2 ** 30 })
})

it('waits for memory pressure to clear and does not overbook a whole-machine reservation', () => {
  const first = hostCiCapacity(machine)
  expect(hostCiCapacity({ ...machine, availableMemoryBytes: 2 * 2 ** 30 }, [first]))
    .toMatchObject({ slotsTotal: 1, slotsUsed: 1 })
  expect(hostCiCapacity(machine, [{ cpuCount: machine.cpuCount, memoryBytes: machine.memoryBytes }]))
    .toMatchObject({ slotsTotal: 1, slotsUsed: 1 })
})
