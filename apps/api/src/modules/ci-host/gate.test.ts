import { expect, it } from 'vitest'
import type { CiRunInput, CiRunRecord } from '@foreman-code/contracts'
import { gatePartStealer, planCiGate } from './gate.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'

function fleet(clouds: number, unavailable?: string): HostCiEndpoint {
  const computers: HostCiComputer[] = [
    { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
    { key: 'builder-paired', label: 'Paired builder', priority: 50,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
    ...Array.from({ length: clouds }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  return {
    computers: async () => computers,
    request: async computer => {
      if (computer.key === 'builder-paired' && unavailable) {
        if (unavailable !== 'not-ready') throw new Error(unavailable)
        return { operation: 'status', ready: false, reasons: ['Builds unavailable'],
          cpuCount: 16, memoryBytes: 32 * 2 ** 30, runs: [] }
      }
      return { operation: 'status', ready: true, reasons: [],
        cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 32 * 2 ** 30,
        slotsUsed: 0, slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2, runs: [] }
    },
  }
}

it.each(['not-ready', 'offline', 'extension-rejected'])('excludes a %s build computer from a requested gate',
  async unavailable => {
    const files = Array.from({ length: 48 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
    const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'gate' },
      { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) },
      { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, fleet(2, unavailable))
    expect(parts.some(part => part.plannedHostKey === 'builder-paired')).toBe(false)
    expect(parts.some(part => part.plannedHostKey === 'builder-main')).toBe(true)
    expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort())
      .toEqual([...files].sort())
  })

it('plans a production-sized gate within a second', async () => {
  const files = Array.from({ length: 800 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const input: CiRunInput = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate' }
  const started = Date.now()
  const parts = await planCiGate(input,
    { files, durations: Object.fromEntries(files.map((file, index) => [file, 5_000 + (index % 40) * 3_000])) },
    { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, fleet(44))
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort()).toEqual([...files].sort())
})

it.each([80_000, 120_000])('balances %i ms integration files against cloud checks', async durationMs => {
  const computers: HostCiComputer[] = [
    { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
    { key: 'builder-paired', label: 'Paired builder', priority: 50,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
    ...Array.from({ length: 24 }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 32 * 2 ** 30,
      slotsUsed: 0, slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2, runs: [] }),
  }
  const files = Array.from({ length: 48 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const input: CiRunInput = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate' }
  const parts = await planCiGate(input, { files, durations: Object.fromEntries(files.map(file => [file, durationMs])) },
    { files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.tsx'], durations: {}, heavy: [] }, {}, endpoint)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  expect(integration.filter(part => part.plannedHostKey.startsWith('builder-'))).toHaveLength(2)
  const times = new Map<string, number>()
  for (const part of parts) {
    times.set(part.plannedHostKey, (times.get(part.plannedHostKey) ?? 0) + part.expectedDurationMs)
  }
  expect(Math.max(...times.values())).toBeLessThanOrEqual(210_000)
})

it('lets a build computer whose own gate part started take unstarted cloud gate parts', () => {
  const host: HostCiComputer = { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } }
  const paired: HostCiComputer = { key: 'builder-paired', label: 'Paired builder', priority: 50,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } }
  const cloud: HostCiComputer = { key: 'cloud-0', label: 'Cloud 0', priority: 30,
    hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 } }
  const part = (plannedHostKey: string, suite: 'integration' | 'unit' = 'integration') =>
    ({ gate: true, suite, plannedHostKey }) as unknown as CiRunRecord
  const queued = [part('cloud-0'), part('builder-paired'), part('cloud-0', 'unit')]
  const steals = gatePartStealer([host, paired, cloud], queued)
  expect(steals(queued[0]!, host)).toBe(true)
  expect(steals(queued[0]!, paired)).toBe(false)
  expect(steals(queued[0]!, cloud)).toBe(false)
  expect(steals(queued[2]!, host)).toBe(false)
  expect(steals(queued[1]!, host)).toBe(false)
})
