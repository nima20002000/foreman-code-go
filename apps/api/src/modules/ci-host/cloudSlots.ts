import type pg from 'pg'
import type { CiHostRequest, CiRunRecord } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import { componentLogger } from '../diagnostics/logger.js'
import { claimCiDispatch } from './dispatch.js'
import { CI_BUSY_TICKET } from './deadlines.js'
import type { HostCiComputer } from './serviceTypes.js'

const log = componentLogger('jobs')

/** Cloud slots a gate leaves free for non-gate tickets, such as fix verifications, unless the product sets another count. */
export const DEFAULT_RESERVED_CLOUD_SLOTS = 4
export const RESERVED_CLOUD_SLOTS_SETTING = 'FOREMAN_CODE_CI_RESERVED_CLOUD_SLOTS'

export function configuredReservedCloudSlots(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[RESERVED_CLOUD_SLOTS_SETTING]?.trim()
  if (!raw) return DEFAULT_RESERVED_CLOUD_SLOTS
  const value = Number(raw)
  if (Number.isInteger(value) && value >= 0) return value
  log.warn({ setting: RESERVED_CLOUD_SLOTS_SETTING, value: raw.slice(0, 40) },
    'Invalid reserved cloud CI slot count; using the default')
  return DEFAULT_RESERVED_CLOUD_SLOTS
}

/** The cloud slots gate tickets never plan or run on, taken round-robin over providers from each provider's highest
 * slots so every provider keeps capacity for non-gate work. Each provider keeps at least one slot for the gate. */
export function reservedCloudSlotKeys(computers: readonly HostCiComputer[], count: number): Set<string> {
  const providers = new Map<string, HostCiComputer[]>()
  for (const computer of computers) {
    if (computer.hostRef.kind !== 'cloud') continue
    const provider = computer.hostRef.provider ?? ''
    providers.set(provider, [...providers.get(provider) ?? [], computer])
  }
  const slots = [...providers.values()].map(list => [...list]
    .sort((left, right) => (right.hostRef.slot ?? 0) - (left.hostRef.slot ?? 0)))
  const reserved = new Set<string>()
  const taken = slots.map(() => 0)
  let progress = true
  while (reserved.size < count && progress) {
    progress = false
    for (const [index, list] of slots.entries()) {
      if (reserved.size >= count || list.length - taken[index]! <= 1) continue
      reserved.add(list[taken[index]!]!.key)
      taken[index] = taken[index]! + 1
      progress = true
    }
  }
  return reserved
}

export function withoutReservedCloudSlots(computers: HostCiComputer[], count: number): HostCiComputer[] {
  const reserved = reservedCloudSlotKeys(computers, count)
  return computers.filter(computer => !reserved.has(computer.key))
}

/** A cloud slot runs one ticket. The claim holds the slot's lock and rechecks persisted assignments, so a dispatcher
 * working from an older capacity snapshot cannot start a second ticket on a busy slot. */
export async function claimCiSlot(pool: pg.Pool, run: CiRunRecord, computer: HostCiComputer,
  request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiRunRecord | 'busy' | null> {
  if (computer.hostRef.kind !== 'cloud') return claimCiDispatch(pool, run, computer, request)
  return withTransaction(pool, async client => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`ci-cloud-slot:${computer.key}`])
    const assigned = (await client.query<{ host_key: string | null }>(`select host_key from ci_runs
      where host_key=$1 and (${CI_BUSY_TICKET}) limit 1`, [computer.key])).rows
    if (assigned.some(row => row.host_key === computer.key)) return 'busy' as const
    return claimCiDispatch(client, run, computer, request)
  })
}
