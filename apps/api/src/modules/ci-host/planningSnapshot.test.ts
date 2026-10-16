import type { CiHostReply } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { CiPlanningSnapshot } from './planningSnapshot.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

afterEach(() => { vi.useRealTimers() })

const computer: HostCiComputer = { key: 'fixture-host', label: 'Build executor', priority: 60,
  hostRef: { kind: 'main', mainId: 'fixture-main' } }
const ready: CiHostReply = { operation: 'status', ready: true, reasons: [], cpuCount: 8,
  memoryBytes: 16 * 2 ** 30, slotsTotal: 2, slotsUsed: 0, runs: [] }

function snapshot() {
  const replies: Array<Promise<CiHostReply>> = []
  const endpoint: HostCiEndpoint = {
    computers: async () => [computer],
    request: vi.fn<HostCiEndpoint['request']>(async () => replies.shift() ?? ready),
  }
  return { planning: new CiPlanningSnapshot(endpoint), replies }
}

it('keeps a healthy computer dispatchable while its expired status refreshes', async () => {
  vi.useFakeTimers()
  const f = snapshot()
  await f.planning.request(computer, { operation: 'status' })
  await vi.advanceTimersByTimeAsync(6000)
  const refresh = deferred<CiHostReply>()
  f.replies.push(refresh.promise)
  void f.planning.request(computer, { operation: 'status' })

  expect(f.planning.dispatchStatus(computer)).toMatchObject({ ready: true, slotsTotal: 2 })
  refresh.resolve(ready)
})

it('stops trusting a last status once its refresh has stalled too long', async () => {
  vi.useFakeTimers()
  const f = snapshot()
  await f.planning.request(computer, { operation: 'status' })
  f.replies.push(deferred<CiHostReply>().promise)
  await vi.advanceTimersByTimeAsync(6000)
  void f.planning.request(computer, { operation: 'status' })
  await vi.advanceTimersByTimeAsync(30_000)

  expect(f.planning.dispatchStatus(computer)).toBeUndefined()
})

it('drops the last status when a refresh fails', async () => {
  vi.useFakeTimers()
  const f = snapshot()
  await f.planning.request(computer, { operation: 'status' })
  await vi.advanceTimersByTimeAsync(6000)
  f.planning.invalidate(computer)

  expect(f.planning.dispatchStatus(computer)).toBeUndefined()
})
