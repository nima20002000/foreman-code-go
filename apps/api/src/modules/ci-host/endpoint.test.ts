import type pg from 'pg'
import { expect, it } from 'vitest'
import { ProductionHostCiEndpoint } from './endpoint.js'
import type { HostCiComputer } from './service.js'

it.each([undefined, 1, 2])('derives Worker readiness from start protocol %s', async version => {
  const computer: HostCiComputer = { key: 'fixture:worker',
    hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-worker' }, label: 'Fixture Worker', priority: 50 }
  const status = { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [],
    ...(version !== undefined ? { startProtocolVersion: version } : {}) }
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
    capabilities: () => [], request: async () => ({ payload: status }),
  }), { handle: async () => { throw new Error('Local runner must not be used.') } })
  const result = await endpoint.request(computer, { operation: 'status' })
  expect(result).toMatchObject({ operation: 'status', ready: version === 2 })
  if (version !== 2) expect(result).toMatchObject({ reasons: [expect.stringMatching(/CI start protocol.*update/i)] })
})
