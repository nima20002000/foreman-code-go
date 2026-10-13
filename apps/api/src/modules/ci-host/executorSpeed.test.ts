import { expect, it } from 'vitest'
import { CiRunRecordSchema, type CiRunInput, type CiRunRecord } from '@foreman-code/contracts'
import { planCiGate } from './gate.js'
import { estimateExecutorSpeeds } from './executorSpeed.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'

const computers: HostCiComputer[] = [
  { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
  { key: 'builder-paired', label: 'Paired builder', priority: 50,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
  { key: 'builder-spare', label: 'Spare builder', priority: 40,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } },
  ...[0, 1].map(slot => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
    hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
    userSystemd: { supported: true, reason: null } })),
]

let sequence = 0
function gatePart(ranOn: HostCiComputer, plannedHostKey: string, expectedDurationMs: number, actualMs: number,
  extra: Partial<CiRunRecord> = {}): CiRunRecord {
  sequence += 1
  const started = Date.parse('2026-10-13T10:00:00.000Z')
  return CiRunRecordSchema.parse({
    id: `11111111-1111-4111-8111-${String(sequence).padStart(12, '0')}`, workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'integration', part: null, gate: true,
    scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'passed', computer: { hostRef: ranOn.hostRef, label: ranOn.label }, step: 'integration',
    exitCode: 0, message: null, queuedAt: new Date(started).toISOString(),
    startedAt: new Date(started).toISOString(), finishedAt: new Date(started + actualMs).toISOString(),
    initiator: { principalId: 'worker', executionId: 'execution' },
    plannedHostKey, expectedDurationMs, ...extra,
  })
}

it('learns each executor speed from recent passed gate parts it was planned for', () => {
  const [main, paired, spare, cloud0, cloud1] = computers as [HostCiComputer, HostCiComputer, HostCiComputer,
    HostCiComputer, HostCiComputer]
  const runs = [
    ...[2, 1.8, 2.2, 2, 2.1].map(ratio => gatePart(main, main.key, 300_000, 300_000 * ratio)),
    // A part planned with a factor already applied still reveals the unscaled speed.
    gatePart(cloud1, cloud0.key, 150_000, 150_000, { speedFactor: 0.6 }),
    gatePart(cloud0, cloud0.key, 150_000, 90_000),
    // Stolen parts were sized for another computer, and failures say nothing about speed.
    gatePart(paired, cloud0.key, 100_000, 900_000),
    gatePart(paired, paired.key, 100_000, 900_000, { state: 'failed', exitCode: 1 }),
    gatePart(spare, spare.key, 100_000, 900_000),
  ]
  const speeds = estimateExecutorSpeeds(runs, computers)
  expect(speeds.get(main.key)).toBe(2)
  expect(speeds.get('cloud:github')).toBeCloseTo(0.6)
  expect(speeds.has(paired.key)).toBe(false)
  expect(speeds.get(spare.key)).toBe(3)
  expect(estimateExecutorSpeeds([], computers).size).toBe(0)
})

function endpoint(): HostCiEndpoint {
  const fleet = computers.filter(computer => computer.key !== 'builder-spare')
  return {
    computers: async () => fleet,
    request: async computer => ({ operation: 'status', ready: true, reasons: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 2, memoryBytes: 32 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1, runs: [] }),
  }
}

async function builderPlan(speeds?: Map<string, number>) {
  const files = Array.from({ length: 160 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 30_000]))
  const input: CiRunInput = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate' }
  const parts = await planCiGate(input, { files, durations },
    { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, endpoint(), speeds)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  const part = (key: string) => integration.find(item => item.plannedHostKey === key)!
  const work = (key: string) => part(key).files.length * 30_000
  return { main: part('builder-main'), paired: part('builder-paired'),
    mainWork: work('builder-main'), pairedWork: work('builder-paired') }
}

it('gives a slower computer proportionally less work so predicted finishes balance', async () => {
  const { main, paired, mainWork, pairedWork } = await builderPlan(new Map([['builder-main', 2]]))
  expect(mainWork).toBeLessThan(pairedWork * 0.55)
  expect(main.speedFactor).toBe(2)
  expect(Math.abs(main.expectedDurationMs - paired.expectedDurationMs)).toBeLessThanOrEqual(60_000)
})

it('treats computers without speed history as nominal', async () => {
  const { main, paired, mainWork, pairedWork } = await builderPlan()
  expect(Math.abs(mainWork - pairedWork)).toBeLessThanOrEqual(30_000)
  expect(main.speedFactor ?? 1).toBe(1)
  expect(Math.abs(main.expectedDurationMs - paired.expectedDurationMs)).toBeLessThanOrEqual(30_000)
})
