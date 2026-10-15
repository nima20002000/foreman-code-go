import type pg from 'pg'
import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { createDatabase } from '../src/infrastructure/database.js'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { deferred } from './helpers/deferred.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('dispatches a queued MCP ticket while an observation holds every shared database connection', async () => {
  const f = await fixture({ databasePool: connectionString => createDatabase({
    connectionString, maxConnections: 1, connectionTimeoutMs: 100, queryTimeoutMs: 1000,
  }).pool })
  const idle = f.computers.pop()!
  const entered = deferred()
  const release = deferred()
  let saturate = false
  let held: pg.PoolClient | undefined
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input, options) => {
    if (input.operation === 'read' && saturate && !held) {
      held = await f.pool.connect()
      entered.resolve()
      try {
        await release.promise
      } finally {
        held.release()
      }
    }
    return request(computer, input, options)
  }
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'affected', files: ['apps/api/test/site.integration.test.ts'] }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { ...input, commit: 'a'.repeat(40) }))
    await vi.waitFor(() => expect(f.started).toHaveLength(1))
    const queued = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { ...input, commit: 'b'.repeat(40) }))
    const before = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: queued.ticketId }))
    expect(before.run.state).toBe('queued')
    saturate = true
    void f.ci.dispatch()
    await entered.promise
    f.computers.push(idle)
    void f.ci.dispatch()
    await vi.waitFor(() => {
      expect(f.started.some(start => start.request.operation === 'start'
        && start.request.runId === queued.ticketId && start.computer === idle.label)).toBe(true)
    }, { timeout: 3500 })
    release.resolve()
    const saved = await f.waitFor(reader, queued.ticketId, output => output.run.state === 'running')
    expect(saved.run).toMatchObject({ id: queued.ticketId, state: 'running', computer: { hostRef: idle.hostRef } })
    expect(saved.run.id).not.toBe(first.ticketId)
  } finally {
    release.resolve()
    await f.close()
  }
})
