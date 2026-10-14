import type pg from 'pg'
import { CiHostRequestSchema, type CiHostRequest } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { ProductionHostCiEndpoint } from './endpoint.js'
import type { HostCiComputer } from './service.js'

it.each([undefined, 1, 2, 3])('derives Worker readiness from start protocol %s', async version => {
  const computer: HostCiComputer = { key: 'fixture:worker',
    hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-worker' }, label: 'Fixture Worker', priority: 50 }
  const status = { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [],
    ...(version !== undefined ? { startProtocolVersion: version } : {}) }
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
    capabilities: () => [], request: async () => ({ payload: status }),
  }), { handle: async () => { throw new Error('Local runner must not be used.') } })
  const result = await endpoint.request(computer, { operation: 'status' })
  expect(result).toMatchObject({ operation: 'status', ready: version === 3 })
  if (version !== 3) expect(result).toMatchObject({ reasons: [expect.stringMatching(/CI start protocol.*update/i)] })
})

it('lists computers without waiting for a slow cloud recovery sweep', async () => {
  const cloud = { provider: { id: 'circleci' }, reconcile: () => new Promise<void>(() => {}),
    computers: () => [{ key: 'fixture:cloud:0', hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', slot: 0 },
      label: 'Cloud 1', priority: 30 }] }
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const endpoint = new ProductionHostCiEndpoint(pool, 'fixture-main', () => undefined,
    { handle: async () => { throw new Error('Local runner must not be used.') } }, [cloud as never])
  const listed = await Promise.race([endpoint.computers(),
    new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 1000))])
  expect(listed).toEqual(cloud.computers())
})

it('answers a status request without waiting for a slow directory retention sweep', async () => {
  const computer: HostCiComputer = { key: 'fixture:main', hostRef: { kind: 'main', mainId: 'fixture-main' },
    label: 'Main computer', priority: 60 }
  const status = { operation: 'status' as const, ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30,
    runs: [], startProtocolVersion: 3, cleanupSupported: true }
  const sweeping = deferred()
  const release = deferred()
  const completed = deferred()
  const cleanupRequests: CiHostRequest[] = []
  const pool = { query: async () => {
    return { rows: [{ run_id: 'old-run', state: 'passed', finished_at: '2026-01-01T00:00:00Z',
      collection: null, rank: '500' }] }
  } } as unknown as pg.Pool
  const endpoint = new ProductionHostCiEndpoint(pool, 'fixture-main', () => undefined, {
    handle: async payload => {
      const request = CiHostRequestSchema.parse(payload)
      if (request.operation === 'status' && request.cleanupRunIds) {
        cleanupRequests.push(request)
        sweeping.resolve()
        await release.promise
        completed.resolve()
        return { ...status, removedRunIds: request.cleanupRunIds }
      }
      return status
    },
  })
  const pending = endpoint.request(computer, { operation: 'status' })
  await sweeping.promise
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([pending,
      new Promise<'blocked'>(resolve => { timeout = setTimeout(() => resolve('blocked'), 1000) })])
    expect(result).toMatchObject({ operation: 'status', ready: true })
    const second = await endpoint.request(computer, { operation: 'status' })
    expect(second).toMatchObject({ operation: 'status', ready: true })
    expect(cleanupRequests).toEqual([{ operation: 'status', cleanupRunIds: ['old-run'], buildAllowancePercent: 100 }])
  } finally {
    clearTimeout(timeout)
    release.resolve()
    await pending
    await completed.promise
  }
})
