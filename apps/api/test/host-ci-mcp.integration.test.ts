import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema,
  type CiHostRequest, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { DomainError } from '../src/modules/errors.js'

/** Two build computers that answer the host CI protocol from memory; tests finish their runs. */
function fakeComputers(github: Record<string, boolean> = {}) {
  const mainId = randomUUID()
  const computers: HostCiComputer[] = ['laptop', 'builder'].map((name, index) => ({ key: `${mainId}:${name}`,
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, label: name, priority: 60 - index }))
  const runs = new Map<string, { computer: string; run: CiHostRun; log: string; request: CiHostRequest
    durations?: Record<string, number> }>()
  const started: { computer: string; request: CiHostRequest }[] = []
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        return { operation: 'status', ready: github[computer.label] !== false, cpuCount: 16, memoryBytes: 14 * 2 ** 30,
          reasons: github[computer.label] === false ? ['Log in to GitHub on this computer (gh auth login).'] : [],
          runs: [...runs.values()].filter(value => value.computer === computer.label).map(value => value.run) }
      }
      if (request.operation === 'start') {
        if (github[computer.label] === false) throw new DomainError('COMPUTER_GITHUB_REQUIRED', 'Log in to GitHub.', 409)
        const existing = runs.get(request.runId)
        if (existing) return { operation: 'start', run: existing.run }
        if ([...runs.values()].some(value => value.computer === computer.label && value.run.state === 'running')) {
          throw new DomainError('CI_HOST_BUSY', 'Busy.', 409)
        }
        const run: CiHostRun = { runId: request.runId, state: 'running', step: 'install', exitCode: null,
          startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null }
        runs.set(request.runId, { computer: computer.label, run, log: '', request })
        started.push({ computer: computer.label, request })
        return { operation: 'start', run }
      }
      const entry = runs.get(request.runId)
      if (!entry) throw new DomainError('CI_RUN_UNKNOWN', 'Unknown run.', 404)
      if (request.operation === 'cancel') {
        entry.run = { ...entry.run, state: 'canceled', finishedAt: new Date().toISOString(), message: 'Canceled.' }
        return { operation: 'cancel', run: entry.run }
      }
      const text = entry.log.slice(request.afterOffset, request.afterOffset + request.maxBytes)
      const finished = !['starting', 'running'].includes(entry.run.state)
      return { operation: 'read', run: entry.run, text, nextOffset: request.afterOffset + Buffer.byteLength(text),
        ...(request.durations && finished && entry.durations ? { durations: entry.durations } : {}) }
    },
  }
  const finish = (runId: string, exitCode: number, log: string, durations?: Record<string, number>) => {
    const entry = runs.get(runId)!
    entry.log = log
    if (durations) entry.durations = durations
    else delete entry.durations
    entry.run = { ...entry.run, state: exitCode === 0 ? 'passed' : 'failed', exitCode, step: entry.request.operation === 'start'
      ? entry.request.suite : null, finishedAt: new Date().toISOString(), logBytes: Buffer.byteLength(log) }
  }
  return { endpoint, started, finish, computers }
}

async function fixture(options: { repository?: boolean; github?: Record<string, boolean> } = {}) {
  const runtime = await codexApprovalRuntime('user')
  const workspaceId = runtime.f.scope.workspaceId
  if (options.repository !== false) {
    await runtime.db.pool.query(`update workspaces set record=record || '{"repository":{"provider":"github","owner":"octo","name":"site","defaultBranch":"main"}}'::jsonb where id=$1`,
      [workspaceId])
  }
  const published: string[] = []
  const commits = { resolve: async (_repository: string, _branch: string, commit: string | undefined) => {
    const resolved = commit ?? 'a'.repeat(40)
    published.push(resolved)
    return resolved
  } }
  const computers = fakeComputers(options.github)
  const commands = new PostgresCommandCoordinator(runtime.db.pool)
  const ci = new HostCiService(runtime.db.pool, commands, new RunCiAuthority(runtime.db.pool), commits, computers.endpoint)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: runtime.access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: ManagementAction[], scope: Record<string, unknown> = { workspaceIds: [workspaceId] }) => {
    const issued = await runtime.access.issue({ name: 'CI Operator', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope }] })
    const client = new Client({ name: 'host-ci-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS, 'jobs:cancel'])
  const call = async (client: Client, name: string, input: Record<string, unknown>) =>
    client.callTool({ name, arguments: { workspaceId, ...input } })
  const value = async (client: Client, name: string, input: Record<string, unknown>) => {
    const result = await call(client, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  return { ...computers, ci, workspaceId, operator, connect, call, value, published, pool: runtime.db.pool,
    async close() {
      await Promise.all(clients.map(client => client.close()))
      await ci.close()
      await app.close()
      await runtime.close()
    } }
}

it('splits integration over two build computers, reports progress and logs, and replays a retried command', async () => {
  const f = await fixture()
  try {
    const input = { suite: 'integration', commandId: 'split-integration', partitions: 2 }
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(2)
    expect(f.published).toHaveLength(1)
    await f.ci.dispatch()
    expect(f.started.map(value => value.computer).sort()).toEqual(['builder', 'laptop'])
    expect(f.started.map(value => value.request.operation === 'start' && value.request.partition?.index).sort())
      .toEqual([0, 1])
    const running = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(running.run).toMatchObject({ state: 'running', suite: 'integration', repository: 'octo/site',
      partition: { index: 0, count: 2 }, computer: { label: expect.any(String) } })
    expect(running.partitions).toHaveLength(2)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    for (const [index, partition] of started.partitions!.entries()) {
      f.finish(partition.ticketId, index, index ? 'FAIL apps/api/test/b.integration.test.ts\n' : 'all passed\n')
    }
    const passed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.partitions![0]!.ticketId }))
    expect(passed.run).toMatchObject({ state: 'passed', exitCode: 0 })
    expect(passed.logTail).toBe('all passed\n')
    const failed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.partitions![1]!.ticketId }))
    expect(failed.run).toMatchObject({ state: 'failed', exitCode: 1 })
    expect(CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ticketId: started.partitions![1]!.ticketId,
      afterOffset: 5 }))).toEqual({ text: 'apps/api/test/b.integration.test.ts\n', nextOffset: 41, logBytes: 41 })
  } finally { await f.close() }
})

it('sizes each partition by the measured speed of the computer it is planned for', async () => {
  const f = await fixture()
  try {
    // History: laptop finished half the suite in 200 s, builder half in 400 s, so laptop works twice as fast.
    for (const [index, computer, seconds] of [[0, f.computers[0]!, 200], [1, f.computers[1]!, 400]] as const) {
      const finishedAt = new Date(Date.now() - 60_000), startedAt = new Date(finishedAt.getTime() - seconds * 1000)
      const run = { id: crypto.randomUUID(), workspaceId: f.workspaceId, suite: 'integration', commit: 'b'.repeat(40),
        repository: 'octo/site', partition: { index, count: 2 }, groupId: crypto.randomUUID(), state: 'passed',
        computer: { hostRef: computer.hostRef, label: computer.label }, step: 'integration', exitCode: 0, message: null,
        queuedAt: startedAt.toISOString(), startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
        initiator: { principalId: 'principal-history', executionId: null } }
      await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,'passed',$4::jsonb)`,
        [run.id, f.workspaceId, run.groupId, JSON.stringify(run)])
    }
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'weighted',
      partitions: 2 }))
    await f.ci.dispatch()
    const requests = f.started.map(value => ({ computer: value.computer,
      partition: value.request.operation === 'start' ? value.request.partition : undefined }))
    expect(requests).toHaveLength(2)
    const weights = requests[0]!.partition!.weights!
    expect(requests.every(value => JSON.stringify(value.partition!.weights) === JSON.stringify(weights))).toBe(true)
    const byComputer = Object.fromEntries(requests.map(value => [value.computer, weights[value.partition!.index]!]))
    expect(byComputer.laptop! / byComputer.builder!).toBeCloseTo(2, 1)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run.partition?.weights).toEqual(weights)
  } finally { await f.close() }
})

it('queues a run while every computer is busy and starts it on the first one that frees up', async () => {
  const f = await fixture()
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'one' }))
    const second = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'lint', commandId: 'two' }))
    const third = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build', commandId: 'three' }))
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: third.ticketId })).run.state).toBe('queued')
    f.finish(first.ticketId, 0, 'ok\n')
    await f.ci.dispatch()
    const moved = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: third.ticketId }))
    expect(moved.run).toMatchObject({ state: 'running', computer: { label: f.started[0]!.computer } })
    expect((await f.call(f.operator, 'ci_logs_read', { ticketId: second.ticketId })).isError).not.toBe(true)
  } finally { await f.close() }
})

it('cancels queued and running runs and skips a computer without a GitHub login', async () => {
  const f = await fixture({ github: { builder: false } })
  try {
    const computers = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(computers.computers.find(value => value.label === 'builder')).toMatchObject({ ready: false,
      reasons: [expect.stringContaining('gh auth login')] })
    const running = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'run' }))
    const queued = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'wait' }))
    await f.ci.dispatch()
    expect(f.started.map(value => value.computer)).toEqual(['laptop'])
    expect(await f.value(f.operator, 'ci_cancel', { ticketId: queued.ticketId })).toMatchObject({ run: { state: 'canceled' } })
    expect(await f.value(f.operator, 'ci_cancel', { ticketId: running.ticketId })).toMatchObject({ run: { state: 'canceled' } })
    await f.ci.dispatch()
    expect(f.started).toHaveLength(1)
  } finally { await f.close() }
})

it('denies callers without CI grants and asks for a GitHub repository first', async () => {
  const f = await fixture({ repository: false })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await f.call(reader, 'ci_run', { suite: 'unit', commandId: 'denied' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const other = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['workspace-other'] })
    expect((await f.call(other, 'ci_run', { suite: 'unit', commandId: 'foreign' })).isError).toBe(true)
    const missing = await f.call(f.operator, 'ci_run', { suite: 'unit', commandId: 'no-repository' })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('SOURCE_REPOSITORY_REQUIRED')
    expect((await f.call(f.operator, 'ci_run', { suite: 'unit', commandId: 'split-unit', partitions: 2 })).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
  } finally { await f.close() }
})

it('learns integration file durations from finished runs and hands every partition of the next run the same ones', async () => {
  const f = await fixture()
  const file = (name: string) => `apps/api/test/${name}.integration.test.ts`
  const startedDurations = () => f.started.map(value => value.request.operation === 'start' ? value.request.durations : 'none')
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-1',
      partitions: 2 }))
    await f.ci.dispatch()
    // Nothing learned yet: the build computers use the commit's committed durations.
    expect(startedDurations()).toEqual([undefined, undefined])
    f.finish(first.partitions![0]!.ticketId, 0, 'ok\n', { [file('a')]: 1000, [file('b')]: 2000 })
    f.finish(first.partitions![1]!.ticketId, 1, 'FAIL\n', { [file('c')]: 3000 })
    await f.ci.dispatch()
    const learned = { [file('a')]: 1000, [file('b')]: 2000, [file('c')]: 3000 }
    const second = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-2',
      partitions: 2 }))
    await f.ci.dispatch()
    expect(startedDurations().slice(2)).toEqual([learned, learned])
    // A slower measurement moves the expectation halfway.
    f.finish(second.partitions![0]!.ticketId, 0, 'ok\n', { [file('a')]: 3000 })
    f.finish(second.partitions![1]!.ticketId, 0, 'ok\n')
    await f.ci.dispatch()
    expect((await f.pool.query(`select file,duration_ms,samples from ci_file_durations where repository='octo/site'
      order by file`)).rows).toEqual([{ file: file('a'), duration_ms: 2000, samples: 2 },
      { file: file('b'), duration_ms: 2000, samples: 1 }, { file: file('c'), duration_ms: 3000, samples: 1 }])
    CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-3' }))
    CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'learn-unit' }))
    // ci_run starts a dispatch of its own, which may predate the second run.
    await f.ci.dispatch()
    await f.ci.dispatch()
    expect(f.started.slice(4).map(value => value.request.operation === 'start' && value.request.suite)).toEqual(['integration', 'unit'])
    expect(startedDurations().slice(4)).toEqual([{ ...learned, [file('a')]: 2000 }, undefined])
  } finally { await f.close() }
})
