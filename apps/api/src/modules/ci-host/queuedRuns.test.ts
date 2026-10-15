import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { readCiGateReservation } from './queuedRuns.js'

function gate(id: string, groupId: string, state: CiRunRecord['state'] = 'queued') {
  return CiRunRecordSchema.parse({
    id, groupId, workspaceId: 'workspace', suite: 'integration', part: null, scope: 'full',
    files: [], partition: null, repository: 'fixture/project', commit: 'a'.repeat(40),
    state, computer: null, step: null, exitCode: null, message: null, gate: true,
    plannedHostKey: 'fixture-executor', queuedAt: '2026-10-15T00:00:00.000Z',
    startedAt: null, finishedAt: null, initiator: { principalId: 'operator', executionId: null },
  })
}

it('checks failures only for live gate groups without hydrating historical failed records', async () => {
  const doomed = gate('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
  const ready = gate('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444')
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ record: doomed }, { record: ready }] })
    .mockResolvedValueOnce({ rows: [{ group_id: doomed.groupId }] })
  const result = await readCiGateReservation({ query } as unknown as pg.Pool)
  expect(result.gate).toEqual(ready)
  expect([...result.reservedHosts]).toEqual(['fixture-executor'])
  expect(query.mock.calls[1]?.[1]).toEqual([[doomed.groupId, ready.groupId]])
})

it('does not query failed gate history when no live gates remain', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  expect(await readCiGateReservation({ query } as unknown as pg.Pool))
    .toEqual({ gate: undefined, reservedHosts: new Set() })
  expect(query).toHaveBeenCalledTimes(1)
})
