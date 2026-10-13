import { CiGetOutputSchema, CiRunOutputSchema, type CiHostRun } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each(['github', 'circleci'] as const)('requeues an unstarted %s ticket and runs it elsewhere through MCP', async provider => {
  const readiness = { laptop: true, builder: false }
  const f = await fixture({ github: readiness,
    cloud: { github: provider === 'github' ? 2 : 0, circleci: provider === 'circleci' ? 2 : 0 } })
  f.computers.splice(1, 1)
  const pending = new Map<string, CiHostRun>()
  const dispatches: string[] = []
  let exhausted = false
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input) => {
    if (computer.hostRef.kind !== 'cloud') return request(computer, input)
    if (input.operation === 'status') return { operation: 'status', ready: true, reasons: [],
      cpuCount: 4, memoryBytes: 16 * 2 ** 30, runs: [] }
    if (input.operation === 'start') {
      if (!pending.has(input.runId)) {
        pending.set(input.runId, { runId: input.runId, state: 'starting', step: 'dispatch', exitCode: null,
          startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null })
        dispatches.push(input.runId)
      }
      return { operation: 'start', run: pending.get(input.runId)! }
    }
    const run = pending.get(input.runId)!
    if (input.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
    return { operation: 'read', run: exhausted ? { ...run, state: 'queued', step: null,
      message: 'Dispatch retries exhausted; queued for another computer.' } : run, text: '', nextOffset: 0 }
  }
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'full', partitions: 2, commandId: 'cloud-recovery' }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const tickets = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const started = { ticketId: tickets.partitions![1]!.ticketId }
    await f.ci.dispatch()
    expect((CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))).run)
      .toMatchObject({ state: 'starting', step: 'dispatch', computer: { hostRef: { provider } } })
    exhausted = true
    const queued = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(queued.run).toMatchObject({ state: 'queued', computer: null, step: null, startedAt: null,
      finishedAt: null, unstartedProviders: [provider], message: expect.stringContaining('dispatch retries exhausted') })
    expect((await f.pool.query('select record,host_key from ci_runs where id=$1', [started.ticketId])).rows[0])
      .toMatchObject({ host_key: null, record: queued.run })
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(tickets)
    f.finish(tickets.ticketId, 0, 'Host slice completed.\n')
    await f.ci.dispatch()
    const running = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(running.run).toMatchObject({ id: started.ticketId, state: 'running', computer: { label: 'laptop' },
      message: null, unstartedProviders: [provider] })
    f.finish(started.ticketId, 0, 'Completed on another computer.\n')
    const finished = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(finished.run).toMatchObject({ state: 'passed', exitCode: 0, message: null })
    expect((await f.pool.query('select record from ci_runs where id=$1', [started.ticketId])).rows[0].record)
      .toEqual(finished.run)
    expect(dispatches).toEqual([started.ticketId])
    expect(f.started.filter(value => value.request.operation === 'start' && value.request.runId === started.ticketId))
      .toHaveLength(1)
  } finally { await f.close() }
})

it('preserves MCP cancellation when an in-flight refresh returns an unstarted ticket', async () => {
  const f = await fixture({ github: { laptop: false, builder: false }, cloud: true })
  f.computers.splice(0, 2)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  let cancellation: Promise<unknown> | undefined
  try {
    const tickets = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'full', partitions: 2, commandId: 'cancel-unstarted',
    }))
    await f.ci.dispatch()
    const running = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: tickets.ticketId }))
    const active = running.partitions!.find(run => run.state === 'running')
    expect(active).toBeDefined()
    const started = { ticketId: active!.id }
    const queued = running.partitions!.filter(run => run.state === 'queued')
    expect(queued).toHaveLength(1)
    for (const run of queued) {
      expect(await f.value(f.operator, 'ci_cancel', { ticketId: run.id }))
        .toMatchObject({ run: { state: 'canceled' } })
    }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_cancel', { ticketId: started.ticketId })).isError).toBe(true)
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      const reply = await request(computer, input)
      if (reply.operation !== 'read') return reply
      entered()
      await blocked
      return { ...reply, run: { ...reply.run, state: 'queued', step: null,
        message: 'Dispatch retries exhausted; queued for another computer.' } }
    }
    const dispatch = f.ci.dispatch()
    await reading
    cancellation = f.value(f.operator, 'ci_cancel', { ticketId: started.ticketId })
    expect(await cancellation).toMatchObject({ run: { state: 'canceled' } })
    const canceled = await reader.callTool({ name: 'ci_get',
      arguments: { workspaceId: f.workspaceId, ticketId: started.ticketId } })
    expect(canceled.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(canceled)).run.state).toBe('canceled')
    release()
    await dispatch
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run.state).toBe('canceled')
    expect((await f.pool.query('select record,host_key from ci_runs where id=$1', [started.ticketId])).rows[0])
      .toEqual({ record: read.run, host_key: null })
    expect(f.started).toHaveLength(1)
    for (const computer of f.computers) {
      const status = await f.endpoint.request(computer, { operation: 'status' })
      expect(status.operation === 'status' && status.runs.some(run => run.state === 'running')).toBe(false)
    }
    expect((await f.pool.query(
      "select count(*)::int as count from management_audit where action='ci.cancel' and target_key=$1",
      [`ci:${started.ticketId}`])).rows).toEqual([{ count: 1 }])
  } finally {
    release()
    try {
      await cancellation
    } finally {
      await f.close()
    }
  }
})
