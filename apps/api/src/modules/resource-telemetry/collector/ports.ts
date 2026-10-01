import type { ResourceCollector, TelemetryIdentity } from '@graphql/contracts/resource-telemetry'
import { boundedReader } from './io.js'
import { qualifyHostConstants, type HostConstants } from './linuxProcfs.js'
import { createResourceCollector, type CollectorClock } from './lifecycle.js'
import type { OwnershipReader } from './ownership.js'

/** Worker/main composition seam; no DB, bootstrap, provider acquisition or runtime-owner acquisition. */
export async function createLinuxResourceCollector(input: {
  identity: TelemetryIdentity
  ownership: OwnershipReader
  wholeHostVisible: boolean
  signal: AbortSignal
  constants?: HostConstants
  clock?: CollectorClock
}): Promise<ResourceCollector> {
  if (process.platform !== 'linux') throw new Error('Linux resource accounting is unavailable.')
  const hostConstants = input.constants ?? await qualifyHostConstants(input.signal)
  input.signal.throwIfAborted()
  if (hostConstants.clockTicksPerSecond <= 0n || hostConstants.pageSize <= 0n) throw new Error('invalid-counter')
  const io = boundedReader(8)
  return createResourceCollector({ identity: input.identity,
    ...(input.clock ? { clock: input.clock } : {}),
    ports: { ...io, ownership: input.ownership, wholeHostVisible: input.wholeHostVisible, constants: hostConstants,
      now: input.clock?.now ?? (() => process.hrtime.bigint()) } })
}
