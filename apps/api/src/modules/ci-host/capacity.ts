const gib = 2 ** 30
const coresPerSlot = 6
const memoryPerSlot = 6 * gib

export function hostCiCapacity(resources: {
  cpuCount: number
  memoryBytes: number
  availableMemoryBytes: number
}, reservations: readonly { cpuCount: number; memoryBytes: number }[] = []) {
  const cpuSlots = Math.max(1, Math.floor(resources.cpuCount / coresPerSlot))
  const memoryBudget = Math.max(1, Math.floor(resources.memoryBytes - Math.max(gib, resources.memoryBytes * 0.1)))
  const reservedCpu = reservations.reduce((sum, run) => sum + run.cpuCount, 0)
  const reservedMemory = reservations.reduce((sum, run) => sum + run.memoryBytes, 0)
  const freeMemory = Math.max(0, Math.min(resources.availableMemoryBytes, memoryBudget - reservedMemory))
  const cpuCount = Math.max(1, Math.floor(resources.cpuCount / cpuSlots))
  const freeSlots = Math.max(0, Math.min(cpuSlots - reservations.length,
    Math.floor((resources.cpuCount - reservedCpu) / cpuCount), Math.floor(freeMemory / memoryPerSlot)))
  const slotsTotal = Math.max(1, reservations.length + freeSlots)
  const memoryBytes = Math.max(1, Math.floor(Math.min(memoryBudget / cpuSlots,
    freeMemory / Math.max(1, freeSlots))))
  return { slotsTotal, slotsUsed: reservations.length, cpuCount, memoryBytes }
}
