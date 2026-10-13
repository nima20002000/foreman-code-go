import { expect, it } from 'vitest'
import type { CiRunInput } from '@foreman-code/contracts'
import { planCiGate } from './gate.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'

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
