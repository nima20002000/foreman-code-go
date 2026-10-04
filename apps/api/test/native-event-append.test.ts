import type { HarnessNativeEvent } from '@foreman-code/contracts'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'

import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'

const event: HarnessNativeEvent = {
  executionId: 'execution', connectionId: 'connection', sequence: 17,
  occurredAt: '2026-09-17T00:00:00.000Z', type: 'assistant.delta', payload: { text: 'hello' },
}

it('uses one atomic database statement for an append or exact replay without managing the caller transaction', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ inserted: false, previously_rejected: false }] })
  await appendNativeEvent({ query } as unknown as pg.ClientBase, event)
  expect(query).toHaveBeenCalledOnce()
  expect(String(query.mock.calls[0]?.[0])).toContain('append_harness_native_event($1::jsonb)')
  expect(String(query.mock.calls[0]?.[0])).toContain('rejected_source')
  expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[0]))).toEqual(event)
})

it('maps only the explicit database identity-conflict SQLSTATE', async () => {
  const query = vi.fn().mockRejectedValue({ code: 'PNE01' })
  await expect(appendNativeEvent({ query } as unknown as pg.ClientBase, event))
    .rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT', status: 409 })
  const databaseFailure = Object.assign(new Error('serialization failure'), { code: '40001' })
  query.mockRejectedValue(databaseFailure)
  await expect(appendNativeEvent({ query } as unknown as pg.ClientBase, event)).rejects.toBe(databaseFailure)
})

it('rejects invalid source events before issuing SQL', async () => {
  const query = vi.fn()
  await expect(appendNativeEvent({ query } as unknown as pg.ClientBase, { ...event, sequence: -1 })).rejects.toThrow()
  expect(query).not.toHaveBeenCalled()
})
