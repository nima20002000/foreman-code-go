import type pg from 'pg'
import type { HostCiEndpoint } from './serviceTypes.js'
import type { CiIntegrationSlots } from './integrationParts.js'
import { componentLogger } from '../diagnostics/logger.js'

const log = componentLogger('jobs')

export interface CiPlanningCapacity extends CiIntegrationSlots {
  usedByComputer: ReadonlyMap<string, number>
}

/** Count ready slots from runner reservations and persisted active tickets. */
export async function readCiSlots(pool: pg.Pool, endpoint: HostCiEndpoint): Promise<CiPlanningCapacity> {
  const active = (await pool.query<{ host_key: string; count: number }>(`select host_key,count(*)::int as count
    from ci_runs where state in ('starting','running') and host_key is not null group by host_key`)).rows
  const used = new Map(active.map(row => [row.host_key, row.count]))
  const slots = { host: 0, ordinary: 0 }
  const computers = await endpoint.computers()
  for (let offset = 0; offset < computers.length; offset += 8) {
    await Promise.all(computers.slice(offset, offset + 8).map(async computer => {
      const status = await endpoint.request(computer, { operation: 'status' }).catch(error => {
        log.warn({ err: error, computer: computer.key }, 'CI capacity unavailable while sizing parts')
        return null
      })
      if (status?.operation !== 'status' || !status.ready) return
      const occupied = Math.max(status.slotsUsed ?? 0, used.get(computer.key) ?? 0)
      used.set(computer.key, occupied)
      const free = Math.max(0, (status.slotsTotal ?? 1) - occupied)
      if (computer.hostRef.kind === 'cloud') slots.ordinary += free
      else slots.host += free
    }))
  }
  // Build computers can also take ordinary work after reserving the host-only slices.
  if (!slots.ordinary) slots.ordinary = Math.max(1, slots.host - 1)
  return { ...slots, usedByComputer: used }
}
