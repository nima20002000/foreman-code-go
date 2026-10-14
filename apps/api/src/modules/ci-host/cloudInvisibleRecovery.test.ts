import { expect, it } from 'vitest'
import { cloudCiLookupFixture } from '../../../test/helpers/cloudCiLookupFixture.js'

it.each(['starting', 'running'] as const)(
  'requeues an invisible CircleCI execution from %s after the visibility window', async state => {
    const f = await cloudCiLookupFixture(state)
    try {
      f.control.operation = 'run'
      f.control.error = 'run.not_found'
      const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 65_536 }
      await expect(f.cloud.handle(request)).resolves.toMatchObject({ run: { state } })
      for (let attempt = 0; attempt < 3; attempt++) {
        f.advance(4_001)
        await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state } })
      }
      f.advance(75_000 - 3 * 4_001)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({
        run: { runId: f.run.runId, state: 'queued', step: null, finishedAt: null, exitCode: null,
          message: expect.stringContaining('queued for another computer') },
        text: expect.stringContaining('queued for another computer'),
      })
      expect(f.control.canceled).toEqual(['pipeline-1'])
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'queued' } })
      expect(f.control.canceled).toEqual(['pipeline-1'])
    } finally { await f.close() }
  },
)

it.each(['run.not_found', 'permission denied', 'rate limit reached'])(
  'requeues despite best-effort CircleCI cancellation failing with %s', async cancelError => {
    const f = await cloudCiLookupFixture('running')
    try {
      f.control.operation = 'run'
      f.control.error = 'run.not_found'
      f.control.cancelError = cancelError
      const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 65_536 }
      await f.cloud.handle(request)
      f.advance(75_000)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'queued',
        message: expect.stringContaining('Cancellation could not be confirmed') } })
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'queued' } })
      expect(f.control.canceled).toEqual(['pipeline-1'])
    } finally { await f.close() }
  },
)

it('resumes recovery of a CircleCI ticket retained after the old reconciliation limit', async () => {
  const f = await cloudCiLookupFixture('running', {
    attempts: 3, at: new Date(Date.now() - 600_000).toISOString(), previousMessage: null,
  })
  try {
    f.control.operation = 'run'
    f.control.error = 'run.not_found'
    await expect(f.reopen().handle({ operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }))
      .resolves.toMatchObject({ run: { state: 'queued' } })
    expect(f.control.canceled).toEqual(['pipeline-1'])
  } finally { await f.close() }
})

it('clears the visibility deadline when CircleCI becomes visible again', async () => {
  const f = await cloudCiLookupFixture('running')
  try {
    f.control.operation = 'run'
    f.control.error = 'run.not_found'
    const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
    await f.cloud.handle(request)
    f.advance(70_000)
    f.control.error = ''
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'running', message: null } })
    f.advance(4_001)
    f.control.error = 'run.not_found'
    await f.reopen().handle(request)
    f.advance(70_000)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'running' } })
    expect(f.control.canceled).toEqual([])
    f.advance(5_000)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'queued' } })
  } finally { await f.close() }
})

it.each(['starting', 'running'] as const)(
  'keeps an older CircleCI execution through a transient lookup failure from %s', async state => {
    const f = await cloudCiLookupFixture(state)
    try {
      const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
      f.advance(120_000)
      f.control.error = 'run.not_found'
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state, finishedAt: null } })
      f.advance(74_999)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state, finishedAt: null } })
      f.control.error = ''
      f.advance(4_001)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'running', message: null } })
      expect(f.control.canceled).toEqual([])
    } finally { await f.close() }
  },
)
