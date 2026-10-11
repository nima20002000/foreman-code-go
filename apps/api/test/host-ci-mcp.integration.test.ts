import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema,
  integrationPartition, type CiHostRequest, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import type { CiUnitInventory } from '../src/modules/ci-host/parts.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { DomainError } from '../src/modules/errors.js'

/** Two build computers that answer the host CI protocol from memory; tests finish their runs. */
function fakeComputers(github: Record<string, boolean> = {}, cloud = false) {
  const mainId = randomUUID()
  const computers: HostCiComputer[] = ['laptop', 'builder'].map((name, index) => ({ key: `${mainId}:${name}`,
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, label: name, priority: 60 - index }))
  if (cloud) computers.push({ key: `${mainId}:cloud:github:0`, hostRef: { kind: 'cloud', mainId, provider: 'github', slot: 0 },
    label: 'GitHub Actions 1', priority: 30 })
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

async function fixture(options: { repository?: boolean; github?: Record<string, boolean>; unitInventory?: CiUnitInventory
  cloud?: boolean } = {}) {
  const runtime = await codexApprovalRuntime('user')
  const workspaceId = runtime.f.scope.workspaceId
  if (options.repository !== false) {
    await runtime.db.pool.query(`update workspaces set record=record || '{"repository":{"provider":"github","owner":"octo","name":"site","defaultBranch":"main"}}'::jsonb where id=$1`,
      [workspaceId])
  }
  const published: string[] = []
  const inventory = options.unitInventory
  const commits = { ...(inventory ? { unitInventory: async () => inventory } : {}),
    resolve: async (_repository: string, _branch: string, commit: string | undefined) => {
    const resolved = commit ?? 'a'.repeat(40)
    published.push(resolved)
    return resolved
  } }
  const computers = fakeComputers(options.github, options.cloud)
  const commands = new PostgresCommandCoordinator(runtime.db.pool)
  const ci = new HostCiService(runtime.db.pool, commands, new RunCiAuthority(runtime.db.pool), commits, computers.endpoint)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: runtime.access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const credential = (actions: ManagementAction[]) => runtime.access.issue({ name: 'CI HTTP caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
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
  return { ...computers, ci, app, credential, workspaceId, operator, connect, call, value, published, pool: runtime.db.pool,
    async close() {
      await Promise.all(clients.map(client => client.close()))
      await ci.close()
      await app.close()
      await runtime.close()
    } }
}

it.each([
  ['unit', 10], ['lint', 2], ['typecheck', 2], ['build', 2],
] as const)('persists and dispatches all %s parts through authenticated MCP', async (suite, count) => {
  const f = await fixture()
  try {
    const input = { suite, commandId: `parts-${suite}` }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(count)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(count)
    expect(read.partitions!.every(run => run.suite === suite && run.part?.startsWith(`${suite}-`)
      && run.groupId === read.run.groupId)).toBe(true)
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows
    expect(stored).toHaveLength(count)
    expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
    for (let pass = 0; pass < count; pass++) {
      await f.ci.dispatch()
      const running = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
      const active = running.partitions!.filter(run => run.state === 'running')
      if (!active.length) break
      for (const run of active) f.finish(run.id, 0, `${run.part} passed\n`)
    }
    const done = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(done.group).toMatchObject({ groupId: read.run.groupId, state: 'passed' })
    expect(f.started).toHaveLength(count)
    expect(f.started.every(item => item.request.operation === 'start' && item.request.part)).toBe(true)
    const logs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ticketId: started.ticketId, group: true, maxBytes: 4096,
    }))
    expect(logs.parts).toHaveLength(count)
    for (const part of logs.parts!) expect(part.text).toBe(`${part.run.part} passed\n`)
  } finally { await f.close() }
})

it('shares split suite and group log readback between authenticated HTTP and MCP', async () => {
  const f = await fixture()
  try {
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const headers = { authorization: `Bearer ${writer.token}` }
    const input = { suite: 'build', commandId: 'http-parts' }
    const reader = await f.credential(CI_GET_ACTIONS)
    expect((await f.app.inject({ method: 'POST', url, payload: input,
      headers: { authorization: `Bearer ${reader.token}` } })).statusCode).toBe(403)
    const response = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(response.statusCode).toBe(200)
    const started = CiRunOutputSchema.parse(response.json())
    expect(started.partitions).toHaveLength(2)
    await f.ci.dispatch()
    for (const [index, ticket] of started.partitions!.entries()) f.finish(ticket.ticketId, index, `result ${index}\n`)
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    const result = CiGetOutputSchema.parse(read.json())
    expect(result.group?.state).toBe('failed')
    expect(result.partitions!.map(run => run.part).sort()).toEqual(['build-api', 'build-other'])
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))).toEqual(result)
    const httpLogs = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}/logs?group=true&maxBytes=4096`, headers })
    expect(httpLogs.statusCode).toBe(200)
    const mcpLogs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ticketId: started.ticketId, group: true, maxBytes: 4096,
    }))
    expect(CiLogsOutputSchema.parse(httpLogs.json())).toEqual(mcpLogs)
    expect(mcpLogs.parts!.map(part => part.text).sort()).toEqual(['result 0\n', 'result 1\n'])
  } finally { await f.close() }
})

it('splits affected unit files without sending an empty part to a computer', async () => {
  const f = await fixture()
  try {
    const files = ['apps/api/test/a.test.ts', 'apps/api/test/b.test.ts', 'apps/api/test/c.test.ts']
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'unit', commandId: 'selected-parts', scope: 'affected', files, commit: 'a'.repeat(40),
    }))
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(3)
    expect(read.partitions!.every(run => run.part === 'unit-api' && run.files.length === 1)).toBe(true)
    expect(read.partitions!.flatMap(run => run.files).sort()).toEqual(files)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    for (const item of f.started) expect(item.request).toMatchObject({ part: 'unit-api', scope: 'affected',
      files: expect.any(Array), partition: { count: 3 } })
  } finally { await f.close() }
})

it('sizes persisted unit parts from committed timings and then from learned unit timings', async () => {
  const files = Array.from({ length: 6 }, (_, index) => `apps/api/test/unit-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 150_000]))
  const f = await fixture({ unitInventory: { files, durations, heavy: [] } })
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'timed-parts' }))
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: first.ticketId }))
    expect(read.partitions!.filter(run => run.part === 'unit-api')).toHaveLength(6)
    const active = read.partitions!.filter(run => run.state === 'running')
    for (const [index, run] of active.entries()) {
      f.finish(run.id, 0, 'passed\n', Object.fromEntries(files.slice(index * 3, index * 3 + 3).map(file => [file, 60_000])))
    }
    await f.ci.dispatch()
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'learned-parts' }))
    const learned = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: next.ticketId }))
    expect(learned.partitions!.filter(run => run.part === 'unit-api')).toHaveLength(3)
    expect((await f.pool.query('select count(*)::int as count from ci_file_durations')).rows[0].count).toBe(6)
  } finally { await f.close() }
})

it('persists affected files through authenticated MCP, bounds partition count and rejects a denied caller', async () => {
  const f = await fixture()
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/c.integration.test.ts']
  const input = { suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40), commandId: 'affected', partitions: 32 }
  try {
    const listed = await f.operator.listTools()
    const tool = listed.tools.find(value => value.name === 'ci_run')!
    expect(tool.inputSchema.properties).toHaveProperty('scope')
    expect(tool.inputSchema.properties).toHaveProperty('files')
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(2)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    for (const item of f.started) expect(item.request).toMatchObject({ scope: 'affected', files, partition: { count: 2 } })
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ scope: 'affected', files })
    const stored = await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [started.ticketId])
    expect(stored.rows[0]!.record).toMatchObject({ scope: 'affected', files })
  } finally { await f.close() }
})

it('shares affected CI validation, grants and persisted readback between HTTP and MCP', async () => {
  const f = await fixture()
  try {
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const headers = { authorization: `Bearer ${writer.token}` }
    const input = { suite: 'unit', scope: 'affected', files: ['apps/api/src/feature.test.ts'],
      commit: 'a'.repeat(40), commandId: 'http-affected' }
    const reader = await f.credential(CI_GET_ACTIONS)
    const denied = await f.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${reader.token}` }, payload: input })
    expect(denied.statusCode).toBe(403)
    const response = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(response.statusCode).toBe(200)
    const started = CiRunOutputSchema.parse(response.json())
    const replay = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(replay.json()).toEqual(started)
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    expect(read.statusCode).toBe(200)
    expect(CiGetOutputSchema.parse(read.json()).run).toMatchObject({ scope: 'affected', files: input.files })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId })).run)
      .toMatchObject({ scope: 'affected', files: input.files })
    const audit = await f.pool.query<{ source: string; outcome: string }>(
      'select source,outcome from management_audit where action=$1', ['ci.run'])
    expect(audit.rows).toEqual(expect.arrayContaining([
      { source: 'http', outcome: 'denied' }, { source: 'http', outcome: 'succeeded' },
    ]))
    for (const invalid of [{ ...input, files: ['../escape.test.ts'] }, { ...input, scope: 'full' },
      { ...input, suite: 'integration' }]) {
      const rejected = await f.app.inject({ method: 'POST', url, headers, payload: invalid })
      expect(rejected.statusCode).toBe(400)
    }
  } finally { await f.close() }
})

it('records an empty affected selection as passed and defaults omitted scope to full', async () => {
  const f = await fixture()
  try {
    const empty = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', scope: 'affected',
      files: [], commit: 'a'.repeat(40), commandId: 'empty', partitions: 32 }))
    expect(empty.partitions).toBeUndefined()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: empty.ticketId }))
    expect(read.run).toMatchObject({ state: 'passed', exitCode: 0, scope: 'affected', files: [], computer: null })
    expect(f.started).toHaveLength(0)
    const full = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'default-full' }))
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: full.ticketId })).run)
      .toMatchObject({ scope: 'full', files: [] })
  } finally { await f.close() }
})

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

it('persists the heavy-file partition plan through authenticated MCP and denies a read-only caller', async () => {
  const f = await fixture()
  const heavy = [
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/local-human-native.integration.test.ts',
  ]
  const files = [...heavy, 'apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts']
  const durations = { [heavy[0]!]: 168_000, [heavy[1]!]: 100_000,
    [files[2]!]: 1_000_000, [files[3]!]: 200_000 }
  try {
    for (const [file, duration] of Object.entries(durations)) {
      await f.pool.query('insert into ci_file_durations(repository,file,duration_ms) values($1,$2,$3)',
        ['octo/site', file, duration])
    }
    const input = { suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40),
      commandId: 'heavy-partitions', partitions: 2 }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect(f.published).toHaveLength(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    const slices = f.started.map(({ request }) => {
      expect(request.operation).toBe('start')
      if (request.operation !== 'start') throw new Error('Expected a start request')
      expect(request.durations).toEqual(durations)
      return integrationPartition(request.files!, request.durations!, request.partition!)
    })
    expect(slices.flat().sort()).toEqual([...files].sort())
    expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1])
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(2)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ scope: 'affected', files, partition: { count: 2, weights: [1, 1] } })
      const stored = await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [run.id])
      expect(stored.rows[0]!.record).toEqual(run)
    }
  } finally { await f.close() }
})

it('queues a run while every computer is busy and starts it on the first one that frees up', async () => {
  const f = await fixture()
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'one' }))
    const second = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'two' }))
    const third = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'three' }))
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
    const running = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'run' }))
    const queued = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'wait' }))
    await f.ci.dispatch()
    expect(f.started.map(value => value.computer)).toEqual(['laptop'])
    expect(await f.value(f.operator, 'ci_cancel', { ticketId: queued.ticketId })).toMatchObject({ run: { state: 'canceled' } })
    expect(await f.value(f.operator, 'ci_cancel', { ticketId: running.ticketId })).toMatchObject({ run: { state: 'canceled' } })
    await f.ci.dispatch()
    expect(f.started).toHaveLength(1)
  } finally { await f.close() }
})

it('lists cloud CI slots beside build computers through MCP', async () => {
  const f = await fixture({ cloud: true })
  try {
    const computers = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(computers.computers.find(value => value.label === 'GitHub Actions 1'))
      .toMatchObject({ hostRef: { kind: 'cloud', provider: 'github', slot: 0 }, priority: 30 })
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
