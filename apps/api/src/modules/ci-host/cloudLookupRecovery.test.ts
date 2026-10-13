import { expect, it } from 'vitest'
import { cloudCiLookupFixture } from '../../../test/helpers/cloudCiLookupFixture.js'

it.each(['starting', 'running'] as const)('persists and bounds permanent CircleCI lookup failures from %s', async state => {
  const f = await cloudCiLookupFixture(state)
  try {
    f.control.error = 'permission denied'
    const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(4_001)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state, finishedAt: null,
        message: expect.stringContaining('permission denied') } })
    }
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state,
      message: expect.stringContaining('Operator cancellation is required') } })
    const reads = f.control.reads
    f.advance(120_000)
    await f.reopen().handle(request)
    expect(f.control.reads).toBe(reads)
    expect(f.control.canceled).toEqual([])
    await expect(f.cloud.handle({ operation: 'cancel', runId: f.run.runId }))
      .resolves.toMatchObject({ run: { state: 'canceled' } })
    expect(f.control.canceled).toEqual(['pipeline-1'])
  } finally { await f.close() }
})

it.each(['permission denied', 'authentication required', 'HTTP 401 Unauthorized', 'HTTP 403 Forbidden'])(
  'recovers a lookup after %s without dispatching another pipeline', async error => {
    const f = await cloudCiLookupFixture('running')
    try {
      f.control.error = error
      const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
      await expect(f.cloud.handle(request)).resolves.toMatchObject({ run: { state: 'running',
        message: expect.stringContaining('could not be reconciled') } })
      f.control.error = ''
      f.advance(4_001)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'running', message: null } })
      expect(f.control.canceled).toEqual([])
    } finally { await f.close() }
  },
)
