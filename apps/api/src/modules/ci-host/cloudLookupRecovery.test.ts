import { expect, it } from 'vitest'
import { cloudCiLookupFixture } from '../../../test/helpers/cloudCiLookupFixture.js'

it.each(['starting', 'running'] as const)('cancels a known CircleCI pipeline after denied lookup from %s', async state => {
  const errors = ['permission denied', 'authentication required', 'HTTP 401 Unauthorized', 'HTTP 403 Forbidden']
  for (const error of errors) {
    const f = await cloudCiLookupFixture(state)
    try {
      f.control.operation = 'run'
      f.control.error = error
      const request = { operation: 'cancel', runId: f.run.runId }
      await expect(f.reopen().handle(request)).resolves.toMatchObject({
        run: { state: 'canceled', finishedAt: expect.any(String), message: 'Canceled.' },
      })
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'canceled' } })
      f.advance(4_001)
      await expect(f.reopen().handle({ operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }))
        .resolves.toMatchObject({ run: { state: 'canceled', message: 'Canceled.' } })
      expect(f.control.canceled).toEqual(['pipeline-1'])
    } finally {
      await f.close()
    }
  }
})

it.each(['starting', 'running'] as const)('requeues permanent CircleCI lookup failures from %s', async state => {
  const f = await cloudCiLookupFixture(state)
  try {
    f.control.error = 'permission denied'
    const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(4_001)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state, finishedAt: null,
        message: expect.stringContaining('permission denied') } })
    }
    const reads = f.control.reads
    f.advance(75_000)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'queued',
      message: expect.stringContaining('queued for another computer') } })
    expect(f.control.reads).toBeGreaterThan(reads)
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
