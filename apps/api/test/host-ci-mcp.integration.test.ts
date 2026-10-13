import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  integrationPartition, userSystemdIntegrationFiles, type CiHostRequest, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import type { CiIntegrationInventory } from '../src/modules/ci-host/integrationParts.js'
import type { CiUnitInventory } from '../src/modules/ci-host/parts.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { DomainError } from '../src/modules/errors.js'
import { AcceptedRepeatStartV1Schema, AcceptedWorkflowRunV3Schema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { acceptRunAuthority, bindRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { genericCiRepository } from './helpers/genericCiRepository.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { onlyCiInfrastructure } from '../src/modules/ci-host/priority.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

// Dispatch and learned timings are global; each case starts with an empty CI queue and history.
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

// CircleCI's Bash startup prepends its real package managers ahead of the fixture shims.
beforeEach(() => { vi.stubEnv('BASH_ENV', '') })
afterEach(() => { vi.unstubAllEnvs() })

/** Two build computers that answer the host CI protocol from memory; tests finish their runs. */
function fakeComputers(github: Record<string, boolean> = {}, cloud: boolean | { github: number; circleci: number } = false,
  hostSlots = 1, cloudSystemd = false) {
  const mainId = randomUUID()
  const computers: HostCiComputer[] = ['laptop', 'builder'].map((name, index) => ({ key: `${mainId}:${name}`,
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, label: name, priority: 60 - index }))
  const slots = typeof cloud === 'boolean' ? { github: Number(cloud), circleci: 0 } : cloud
  for (const provider of ['github', 'circleci'] as const) {
    for (let slot = 0; slot < slots[provider]; slot++) {
      computers.push({ key: `${mainId}:cloud:${provider}:${slot}`, hostRef: { kind: 'cloud', mainId, provider, slot },
        label: `${provider === 'github' ? 'GitHub Actions' : 'CircleCI'} ${slot + 1}`, priority: 30,
        userSystemd: { supported: cloudSystemd, reason: cloudSystemd ? null : 'Executor has no systemd user manager' } })
    }
  }
  const runs = new Map<string, { computer: string; run: CiHostRun; log: string; request: CiHostRequest
    durations?: Record<string, number> }>()
  const started: { computer: string; request: CiHostRequest }[] = []
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        const active = [...runs.values()].filter(value => value.computer === computer.label
          && ['starting', 'running'].includes(value.run.state))
        return { operation: 'status', ready: github[computer.label] !== false, cpuCount: 16, memoryBytes: 14 * 2 ** 30,
          ...(computer.userSystemd ? { userSystemd: computer.userSystemd } : {}),
          slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : hostSlots, slotsUsed: active.length,
          reasons: github[computer.label] === false ? ['Log in to GitHub on this computer (gh auth login).'] : [],
          runs: [...runs.values()].filter(value => value.computer === computer.label).map(value => value.run) }
      }
      if (request.operation === 'start') {
        if (computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'circleci'
          && request.part === 'unit-other') {
          throw new DomainError('CI_CLOUD_UNAVAILABLE', 'CircleCI cannot run the Worker unit tests (no podman).', 409)
        }
        if (github[computer.label] === false) throw new DomainError('COMPUTER_GITHUB_REQUIRED', 'Log in to GitHub.', 409)
        const existing = runs.get(request.runId)
        if (existing) return { operation: 'start', run: existing.run }
        const activeCount = [...runs.values()].filter(value => value.computer === computer.label
          && value.run.state === 'running').length
        if (activeCount >= (computer.hostRef.kind === 'cloud' ? 1 : hostSlots)) {
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
  integrationInventory?: CiIntegrationInventory
  cloud?: boolean | { github: number; circleci: number }; agent?: boolean; hostSlots?: number; cloudSystemd?: boolean
  changedFiles?: string[]; priorityGrant?: boolean
  supersession?: { branch(commit: string): string | null; isAncestor(ancestor: string, commit: string): boolean }
  repositoryRunner?: { commits: CiCommits; endpoint: HostCiEndpoint } } = {}) {
  const saved = options.agent ? makeCurrentWorkflowFixture(randomUUID()) : undefined
  if (saved) {
    saved.configurations = saved.configurations.map(configuration => ({ ...configuration,
      graphqlTools: ['context_get' as const, 'ci_run' as const, 'ci_get' as const, 'ci_logs_read' as const,
        'ci_computers_list' as const] }))
  }
  const runtime = saved ? await codexApprovalRuntime('user', { fixture: saved }) : undefined
  const db = runtime?.db ?? database
  const access = runtime?.access ?? new PostgresAccessService(db.pool)
  const workspaceId = runtime?.f.scope.workspaceId ?? randomUUID()
  if (!runtime) {
    await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI workspace' })])
  }
  if (options.repository !== false) {
    await db.pool.query(`update workspaces set record=record || '{"repository":{"provider":"github","owner":"octo","name":"site","defaultBranch":"main"}}'::jsonb where id=$1`,
      [workspaceId])
  }
  const published: string[] = []
  const inventory = options.unitInventory
  const commits = options.repositoryRunner?.commits ?? {
    infrastructureOnly: async () => onlyCiInfrastructure(options.changedFiles ?? ['apps/web/src/App.tsx']),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    ...(options.integrationInventory ? { integrationInventory: async () => options.integrationInventory! } : {}),
    ...(inventory ? { unitInventory: async () => inventory } : {}),
    ...(options.supersession ? {
      branch: async (_repository: string, _defaultBranch: string, commit: string) => options.supersession!.branch(commit),
      isAncestor: async (_repository: string, ancestor: string, commit: string) =>
        options.supersession!.isAncestor(ancestor, commit),
    } : {}),
    resolve: async (_repository: string, _branch: string, commit: string | undefined) => {
    const resolved = commit ?? 'a'.repeat(40)
    published.push(resolved)
    return resolved
  } }
  const computers = fakeComputers(options.github, options.cloud, options.hostSlots, options.cloudSystemd)
  const commands = new PostgresCommandCoordinator(db.pool)
  const ci = new HostCiService(db.pool, commands, new RunCiAuthority(db.pool), commits,
    options.repositoryRunner?.endpoint ?? computers.endpoint)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices },
    ...(runtime ? { appMcp: { access, commands,
      interactions: new PostgresAppInteractionService(db.pool, runtime.repository, commands) } } : {}) })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const credential = (actions: ManagementAction[]) => access.issue({ name: 'CI HTTP caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
  const connect = async (actions: ManagementAction[], scope: Record<string, unknown> = { workspaceIds: [workspaceId] }) => {
    const issued = await access.issue({ name: 'CI Operator', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope }] })
    const client = new Client({ name: 'host-ci-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS, 'jobs:cancel'])
  const close = async () => {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
    await runtime?.close()
  }
  let agent: Client | undefined
  let connectAgent: (() => Promise<Client>) | undefined
  if (runtime) {
    try {
      await runtime.db.pool.query(`update management_principals set grants=grants || $2::jsonb where id=$1`,
        [runtime.authorizationPrincipalId, JSON.stringify([{ actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS,
          ...(options.priorityGrant ? ['jobs:prioritize'] : [])],
          scope: { workspaceIds: [workspaceId] } }])])
      runtime.f.run = await withExclusiveGraphConnection(runtime.db.pool, connection => connection.transaction(async sql => {
        const client = sql as unknown as pg.PoolClient
        const owner = await currentOperatorAuthority(sql, runtime.authorizationPrincipalId)
        const authority = await acceptRunAuthority(client, owner.principal)
        const version = runtime.f.version
        const workflow = (await sql.query<{ revision: string }>(
          'select revision::text from workflows where id=$1', [version.workflowId])).rows[0]!
        const run = AcceptedWorkflowRunV3Schema.parse({ ...runtime.f.run, id: randomUUID(),
          authorizationPrincipalId: authority.principal.id })
        const accepted = AcceptedRepeatStartV1Schema.parse({ run, snapshot: {
          request: { workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
            executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: Number(workflow.revision),
            expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
            expectedLocationRevision: run.executionLocation.locationRevision, input: run.input },
          authorizationPrincipalId: authority.principal.id,
          executable: { version, configurations: runtime.f.configurations },
          workflow: { id: version.workflowId, workspaceId, revision: Number(workflow.revision),
            currentVersionId: version.id, archived: false, definition: version.definition },
          workspace: { id: workspaceId, archived: false, location: run.executionLocation }, draft: null,
        } })
        const admitted = await insertRepeatRun(sql, accepted, repeatStartPublication)
        await bindRunAuthority(client, admitted.id, authority)
        return admitted
      }))
      runtime.f.scope.runId = runtime.f.run.id
      await runtime.engine.start(runtime.f.run.id)
      const [interaction] = await runtime.pending()
      if (!interaction) throw new Error('Expected an active Agent')
      connectAgent = async () => {
        const issued = await runtime.credentials.issueForExecution(interaction.executionId)
        const client = new Client({ name: 'ci-agent-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { requestInit: { headers: { authorization: `Bearer ${issued.environment.variables.GRAPHQL_MCP_TOKEN!}` } } }))
        return client
      }
      agent = await connectAgent()
    } catch (error) {
      await close()
      throw error
    }
  }
  const call = async (client: Client, name: string, input: Record<string, unknown>) => {
    // Drive the background refresh explicitly; polling itself only reads persisted state.
    if (name === 'ci_get') await ci.dispatch()
    return client.callTool({ name, arguments: { ...(client === agent ? {} : { workspaceId }), ...input } })
  }
  const value = async (client: Client, name: string, input: Record<string, unknown>) => {
    const result = await call(client, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  return { ...computers, ci, app, credential, workspaceId, operator, agent,
    authorizationPrincipalId: runtime?.authorizationPrincipalId,
    connect, connectAgent, call, value, published, pool: db.pool, close }
}

it.each([
  ['pnpm-lock.yaml', 'corepack pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'corepack yarn'],
  [undefined, 'npm'],
])('runs another repository with %s as single jobs through authenticated MCP', async (lockfile, pm) => {
  const repository = await genericCiRepository(lockfile ? { lockfile } : {})
  const f = await fixture({ repositoryRunner: repository })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', { suite: 'build', commandId: 'denied-generic' })).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    for (const suite of ['build', 'lint', 'unit'] as const) {
      const input = { suite, commandId: `generic-${suite}` }
      const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      expect(started.partitions).toBeUndefined()
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
      await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
        { ticketId: started.ticketId })).run.state).toBe('passed')
      const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
      expect(read.run).toMatchObject({ suite, part: null, partition: null, scope: 'full', files: [],
        state: 'passed', exitCode: 0, commit: repository.commit, computer: { hostRef: { kind: 'main' } } })
      expect(read.partitions).toBeUndefined()
      expect(read.logTail).toContain(`${pm} install`)
      expect(read.logTail).toContain(`${pm} run ${suite}`)
      expect(read.logTail).toContain(`fixture ${suite} passed`)
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
        [read.run.groupId])).rows
      expect(stored.map(row => row.record)).toEqual([read.run])
    }
  } finally {
    await f.close()
    await repository.close()
  }
})

it('runs generic integration once despite requested partitions and falls back from an unconfigured cloud mirror', async () => {
  const repository = await genericCiRepository({ integration: true, cloud: true })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run',
      { suite: 'integration', partitions: 4, commandId: 'generic-integration' }))
    expect(started.partitions).toBeUndefined()
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: started.ticketId })).run.state).toBe('passed')
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ part: null, partition: null, state: 'passed',
      computer: { hostRef: { kind: 'main' } } })
    expect(read.logTail).toContain('npm run integration')
    expect(read.logTail.split('\n').filter(line => line === 'npm run integration')).toHaveLength(1)
    expect(read.logTail).toContain('fixture integration passed')
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)).toEqual([read.run])
  } finally {
    await f.close()
    await repository.close()
  }
})

it('runs a generic full suite for an empty affected selection and preserves HTTP and MCP readback', async () => {
  const repository = await genericCiRepository({ cloud: true })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const input = { suite: 'unit', scope: 'affected', files: [], commit: repository.commit, commandId: 'generic-affected' }
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const headers = { authorization: `Bearer ${writer.token}` }
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const reader = await f.credential(CI_GET_ACTIONS)
    const denied = await f.app.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${reader.token}` }, payload: input })
    expect(denied.statusCode).toBe(403)
    const response = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(response.statusCode).toBe(200)
    const started = CiRunOutputSchema.parse(response.json())
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: started.ticketId })).run.state).toBe('passed')
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    expect(read.statusCode).toBe(200)
    const result = CiGetOutputSchema.parse(read.json())
    expect(result.run).toMatchObject({ state: 'passed', part: null, partition: null, scope: 'full', files: [],
      computer: { hostRef: { kind: 'main' } } })
    expect(result.logTail).toContain('fixture unit passed')
    expect(repository.cloudAttempts).toContain(started.ticketId)
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId })).run)
      .toEqual(result.run)
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(result.run)
  } finally {
    await f.close()
    await repository.close()
  }
})

it.each(['typecheck', 'integration'] as const)('reports a missing generic %s script through MCP and persisted readback', async suite => {
  const repository = await genericCiRepository()
  const f = await fixture({ repositoryRunner: repository })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite, commandId: `missing-${suite}` }))
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: started.ticketId })).run.state).toBe('failed')
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ state: 'failed', part: null, partition: null,
      message: `The repository has no "${suite}" script for the ${suite} suite.` })
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(read.run)
  } finally {
    await f.close()
    await repository.close()
  }
})

it('runs another repository’s named parts through its own suite hook', async () => {
  const repository = await genericCiRepository({ suiteHook: true })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build', commandId: 'custom-hook' }))
    expect(started.partitions).toHaveLength(2)
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: started.ticketId })).group!.state).toBe('passed')
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions!.map(run => run.part).sort()).toEqual(['build-api', 'build-other'])
    for (const run of read.partitions!) {
      expect(run.state).toBe('passed')
      const logs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ticketId: run.id }))
      expect(logs.text).toContain(`fixture hook ${run.part} passed`)
    }
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
  } finally {
    await f.close()
    await repository.close()
  }
})

it('runs generic install without an install script and persists a package-script failure', async () => {
  const repository = await genericCiRepository({ suiteExit: 7 })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const install = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'generic-install' }))
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: install.ticketId })).run.state).toBe('passed')
    const installed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: install.ticketId }))
    expect(installed.run).toMatchObject({ part: null, partition: null, step: 'install', exitCode: 0 })
    expect(installed.logTail).toContain('npm install')
    expect(installed.logTail).not.toContain('npm run install')
    const build = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build', commandId: 'generic-failure' }))
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: build.ticketId })).run.state).toBe('failed')
    const failed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: build.ticketId }))
    expect(failed.run).toMatchObject({ part: null, partition: null, step: 'build', state: 'failed', exitCode: 7 })
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [build.ticketId])).rows[0]!.record).toEqual(failed.run)
  } finally {
    await f.close()
    await repository.close()
  }
})

it.each([
  ['unit', 11], ['lint', 2], ['typecheck', 2], ['build', 2],
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
    if (suite === 'unit') {
      const expectedShards = { 'unit-api': 5, 'unit-web': 3, 'unit-web-heavy': 2, 'unit-other': 1 }
      for (const [part, shards] of Object.entries(expectedShards)) {
        const runs = read.partitions!.filter(run => run.part === part)
        expect(runs).toHaveLength(shards)
        expect(runs.map(run => run.partition).sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0)))
          .toEqual(shards === 1 ? [null] : Array.from({ length: shards }, (_, index) => ({ index, count: shards })))
      }
    }
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
    // Completion reaches Main through background refresh, independently of HTTP or MCP reads.
    await expect.poll(async () => {
      const rows = (await f.pool.query<{ record: unknown }>(
        'select record from ci_runs where group_id=(select group_id from ci_runs where id=$1)',
        [started.ticketId])).rows
      return rows.map(row => CiRunRecordSchema.parse(row.record).state).sort()
    }, { timeout: 10_000 }).toEqual(['failed', 'passed'])
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    const result = CiGetOutputSchema.parse(read.json())
    expect(result.group?.state).toBe('failed')
    expect(result.partitions!.map(run => run.part).sort()).toEqual(['build-api', 'build-other'])
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))).toEqual(result)
    const httpLogs = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}/logs?group=true&maxBytes=500000`, headers })
    expect(httpLogs.statusCode).toBe(200)
    const mcpLogs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ticketId: started.ticketId, group: true, maxBytes: 500_000,
    }))
    expect(mcpLogs.maxBytes).toBe(65_536)
    expect(mcpLogs.parts!.every(part => part.maxBytes === 32_768)).toBe(true)
    expect(CiLogsOutputSchema.parse(httpLogs.json())).toEqual(mcpLogs)
    expect(mcpLogs.parts!.map(part => part.text).sort()).toEqual(['result 0\n', 'result 1\n'])
  } finally { await f.close() }
})

it('clamps failed unit log pages for Agents, Operators and HTTP while preserving access checks', async () => {
  const f = await fixture({ agent: true })
  try {
    const agent = f.agent!
    const started = CiRunOutputSchema.parse(decodeMcpToolResult(await agent.callTool({ name: 'ci_run', arguments: {
      suite: 'unit', commandId: 'log-pages', commit: 'a'.repeat(40), scope: 'affected',
      files: ['apps/api/test/example.test.ts'],
    } })))
    await f.ci.dispatch()
    const log = 'x'.repeat(70_000) + '\nunit failed\n'
    f.finish(started.ticketId, 1, log)
    const failed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(failed.run.state).toBe('failed')
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(failed.run)
    const credential = await f.credential(CI_GET_ACTIONS)
    const headers = { authorization: `Bearer ${credential.token}` }
    const url = `/api/management/workspaces/${f.workspaceId}/ci/${started.ticketId}/logs`
    const input = { ticketId: started.ticketId, afterOffset: 0, maxBytes: 500_000 }
    const first = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', input))
    expect(first).toEqual({ text: log.slice(0, 65_536), maxBytes: 65_536, nextOffset: 65_536, logBytes: log.length })
    const agentResult = await agent.callTool({ name: 'ci_logs_read', arguments: input })
    expect(agentResult.isError).not.toBe(true)
    expect(CiLogsOutputSchema.parse(decodeMcpToolResult(agentResult))).toEqual(first)
    const http = await f.app.inject({ method: 'GET', url: `${url}?afterOffset=0&maxBytes=500000`, headers })
    expect(http.statusCode).toBe(200)
    expect(CiLogsOutputSchema.parse(http.json())).toEqual(first)
    const next = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ...input, afterOffset: first.nextOffset,
    }))
    expect(first.text + next.text).toBe(log)
    expect(next.nextOffset).toBe(log.length)
    const tail = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', {
      ticketId: started.ticketId, maxBytes: 500_000,
    }))
    expect(tail).toEqual({ text: log.slice(-65_536), maxBytes: 65_536, nextOffset: log.length, logBytes: log.length })
    const small = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ...input, maxBytes: 10 }))
    expect(small).toEqual({ text: log.slice(0, 10), maxBytes: 10, nextOffset: 10, logBytes: log.length })
    const denied = await f.connect(CI_GET_ACTIONS, { workspaceIds: [randomUUID()] })
    expect((await f.call(denied, 'ci_logs_read', input)).isError).toBe(true)
    const deniedCredential = await f.credential(['jobs:cancel'])
    expect((await f.app.inject({ method: 'GET', url: `${url}?maxBytes=500000`,
      headers: { authorization: `Bearer ${deniedCredential.token}` } })).statusCode).toBe(403)
    for (const maxBytes of [0, -1, 1.5]) {
      expect((await f.call(f.operator, 'ci_logs_read', { ...input, maxBytes })).isError).toBe(true)
      expect((await f.app.inject({ method: 'GET', url: `${url}?maxBytes=${maxBytes}`, headers })).statusCode).toBe(400)
    }
  } finally { await f.close() }
}, 60_000)

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

it('records an empty affected selection as passed and preserves explicit full scope', async () => {
  const f = await fixture()
  try {
    const empty = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', scope: 'affected',
      files: [], commit: 'a'.repeat(40), commandId: 'empty', partitions: 32 }))
    expect(empty.partitions).toBeUndefined()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: empty.ticketId }))
    expect(read.run).toMatchObject({ state: 'passed', exitCode: 0, scope: 'affected', files: [], computer: null })
    expect(f.started).toHaveLength(0)
    const full = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'unit', scope: 'full', commandId: 'explicit-full' }))
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: full.ticketId })).run)
      .toMatchObject({ scope: 'full', files: [] })
  } finally { await f.close() }
})

it('persists an explicit base through authenticated Operator MCP, enforces grants and dispatches it to the runner', async () => {
  const f = await fixture()
  try {
    const baseCommit = 'b'.repeat(40)
    const input = { suite: 'integration', scope: 'affected', baseCommit, commandId: 'release-changes' }
    const tool = (await f.operator.listTools()).tools.find(item => item.name === 'ci_run')!
    expect(tool.inputSchema.properties).toHaveProperty('baseCommit')
    const reader = await f.connect(CI_GET_ACTIONS)
    const foreign = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['workspace-other'] })
    for (const caller of [reader, foreign]) {
      const denied = await f.call(caller, 'ci_run', input)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    }
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    expect((await f.call(f.operator, 'ci_run', { ...input, baseCommit: 'c'.repeat(40) })).isError).toBe(true)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]!.request).toMatchObject({ baseCommit, commit: 'a'.repeat(40), scope: 'affected' })
    expect(f.started[0]!.request).not.toHaveProperty('files')
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ baseCommit, commit: 'a'.repeat(40), scope: 'affected', deriveFiles: true })
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record
    expect(stored).toEqual(read.run)
    f.finish(started.ticketId, 0, 'completed')
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId })).run)
      .toMatchObject({ baseCommit, state: 'passed', exitCode: 0 })
  } finally { await f.close() }
})

it('defaults authenticated Operator MCP and HTTP calls to runner-selected affected scope with denied read-only callers', async () => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const deniedHttp = await f.credential(CI_GET_ACTIONS)
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const headers = { authorization: `Bearer ${writer.token}` }
    for (const scope of [undefined, 'full'] as const) {
      const input = { suite: 'integration', commandId: `mcp-${scope ?? 'default'}`, ...(scope ? { scope } : {}) }
      expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
      const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
      const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
      expect(read.run).toMatchObject({ scope: scope ?? 'affected', files: [] })
      expect(read.run.deriveFiles).toBe(scope === undefined ? true : undefined)
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [started.ticketId])).rows[0]!
      expect(stored.record).toEqual(read.run)
      const httpInput = { ...input, commandId: `http-${scope ?? 'default'}` }
      expect((await f.app.inject({ method: 'POST', url, payload: httpInput,
        headers: { authorization: `Bearer ${deniedHttp.token}` } })).statusCode).toBe(403)
      const response = await f.app.inject({ method: 'POST', url, headers, payload: httpInput })
      expect(response.statusCode).toBe(200)
      const http = CiRunOutputSchema.parse(response.json())
      const httpRead = await f.app.inject({ method: 'GET', url: `${url}/${http.ticketId}`, headers })
      expect(CiGetOutputSchema.parse(httpRead.json()).run).toMatchObject({ scope: scope ?? 'affected', files: [] })
    }
    await f.ci.dispatch()
    const request = f.started.find(item => item.request.operation === 'start' && item.request.scope === 'affected')!.request
    expect(request).toMatchObject({ scope: 'affected', defaultBranch: 'main' })
    expect(request).not.toHaveProperty('files')
  } finally { await f.close() }
})

it('defaults authenticated Agent MCP to affected scope, reads explicit full scope and denies a caller without CI grants', async () => {
  const f = await fixture({ agent: true })
  try {
    const agent = f.agent!
    const tool = (await agent.listTools()).tools.find(item => item.name === 'ci_run')!
    expect(tool.inputSchema.properties).toHaveProperty('scope')
    expect(tool.inputSchema.properties).toHaveProperty('files')
    for (const baseCommit of [undefined, 'b'.repeat(40)]) {
      for (const scope of [undefined, 'full'] as const) {
        const result = await agent.callTool({ name: 'ci_run', arguments: {
          suite: 'integration', commandId: `agent-${scope ?? 'default'}${baseCommit ? '-base' : ''}`,
          ...(baseCommit ? { baseCommit } : {}), ...(scope ? { scope } : {}) } })
        expect(result.isError).not.toBe(true)
        const started = CiRunOutputSchema.parse(decodeMcpToolResult(result))
        const read = await agent.callTool({ name: 'ci_get', arguments: { ticketId: started.ticketId } })
        expect(read.isError).not.toBe(true)
        const run = CiGetOutputSchema.parse(decodeMcpToolResult(read)).run
        expect(run).toMatchObject({ scope: scope ?? 'affected', files: [] })
        expect(run.baseCommit).toBe(baseCommit)
        expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [run.id])).rows[0]!.record)
          .toEqual(run)
      }
    }
    const stored = (await f.pool.query<{ grants: { actions: ManagementAction[]; scope: Record<string, unknown> }[] }>(
      'select grants from management_principals where id=$1', [f.authorizationPrincipalId])).rows[0]!
    const grants = stored.grants.map(grant => ({ ...grant, actions: grant.actions.filter(action => action !== 'jobs:start') }))
    await f.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [f.authorizationPrincipalId, JSON.stringify(grants)])
    expect((await agent.callTool({ name: 'ci_run', arguments: { suite: 'unit', commandId: 'agent-denied' } })).isError).toBe(true)
    expect((await agent.callTool({ name: 'ci_run', arguments: { suite: 'unit', baseCommit: 'b'.repeat(40),
      commandId: 'agent-base-denied' } })).isError).toBe(true)
  } finally { await f.close() }
}, 60_000)

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
      afterOffset: 5 }))).toEqual({ text: 'apps/api/test/b.integration.test.ts\n', nextOffset: 41, logBytes: 41, maxBytes: 65_536 })
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
  const expectedFiles = [...files].sort()
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
      expect(request.files).toEqual(expectedFiles)
      expect(request.durations).toEqual(durations)
      return integrationPartition(request.files!, request.durations!, request.partition!)
    })
    expect(slices.flat().sort()).toEqual([...files].sort())
    expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1])
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(2)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ scope: 'affected', files: expectedFiles, partition: { count: 2, weights: [1, 1] } })
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
    const waiting = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: third.ticketId }))
    expect(waiting.run).toMatchObject({ state: 'queued', priority: 'normal',
      message: expect.stringContaining('all CI slots in use (1/1)') })
    expect(waiting.queue).toEqual({ position: 1, reason: waiting.run.message })
    f.finish(first.ticketId, 0, 'ok\n')
    await f.ci.dispatch()
    const moved = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: third.ticketId }))
    expect(moved.run).toMatchObject({ state: 'running', computer: { label: f.started[0]!.computer }, message: null })
    expect((await f.call(f.operator, 'ci_logs_read', { ticketId: second.ticketId })).isError).not.toBe(true)
  } finally { await f.close() }
})

it.each(['github', 'circleci'] as const)('runs user-systemd slices on capable %s slots through authenticated MCP', async provider => {
  const f = await fixture({ cloud: { github: provider === 'github' ? 2 : 0, circleci: provider === 'circleci' ? 2 : 0 },
    cloudSystemd: true })
  f.computers.splice(0, 2)
  const systemd = 'apps/api/test/native-service-restart.integration.test.ts'
  const ordinary = 'apps/api/test/agent-chat.integration.test.ts'
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'affected', files: [systemd, ordinary], commit: 'a'.repeat(40),
      commandId: 'cloud-systemd' }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect(f.started).toHaveLength(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(2)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud', provider } } })
      expect((await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record).toEqual(run)
    }
    const slices = read.partitions!.map(run => integrationPartition(run.files, {}, run.partition!))
    expect(slices).toContainEqual([systemd])
    expect(slices).toContainEqual([ordinary])
    const listed = CiComputersOutputSchema.parse(await f.value(reader, 'ci_computers_list', {}))
    expect(listed.computers.every(computer => computer.userSystemd?.supported)).toBe(true)
    for (const run of read.partitions!) f.finish(run.id, 0, 'Systemd cloud slice completed.\n')
    const completed = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(completed.partitions!.every(run => run.state === 'passed')).toBe(true)
  } finally { await f.close() }
})

it('queues only user-systemd files through MCP while ordinary files run on cloud, then clears the wait on start', async () => {
  const readiness = { laptop: true }
  const f = await fixture({ github: readiness, cloud: true })
  f.computers.splice(1, 1)
  const systemd = [
    'apps/api/test/workflow-systemd-restart-active.integration.test.ts',
    'apps/api/test/native-service-restart.integration.test.ts',
  ]
  const ordinary = [
    'apps/api/test/agent-chat.integration.test.ts',
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/workflow-systemd-restart.integration.test.ts',
  ]
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const older = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'older-integration',
    }))
    await f.ci.dispatch()
    const slices = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', files: [...systemd, ...ordinary], commit: 'a'.repeat(40),
      commandId: 'waiting-integration',
    }))
    expect(slices.partitions).toHaveLength(2)
    await f.ci.dispatch()
    await f.ci.close()
    const read = async () => {
      const result = await reader.callTool({ name: 'ci_get', arguments: {
        workspaceId: f.workspaceId, ticketId: slices.ticketId,
      } })
      expect(result.isError).not.toBe(true)
      return CiGetOutputSchema.parse(decodeMcpToolResult(result))
    }
    const waiting = await read()
    const host = waiting.partitions!.find(run => run.partition!.hostIndexes!.includes(run.partition!.index))!
    const sibling = waiting.partitions!.find(run => run.id !== host.id)!
    expect(host).toMatchObject({ state: 'queued', computer: null,
      message: expect.stringContaining('all CI slots in use (1/1)') })
    expect(sibling).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud' } } })
    expect(integrationPartition(host.files, {}, host.partition!).sort()).toEqual([...systemd].sort())
    expect(integrationPartition(sibling.files, {}, sibling.partition!).sort()).toEqual([...ordinary].sort())
    expect((await f.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record).toEqual(host)
    const computers = CiComputersOutputSchema.parse(await f.value(reader, 'ci_computers_list', {}))
    expect(computers.computers.find(computer => computer.hostRef.kind === 'cloud')?.userSystemd)
      .toEqual({ supported: false, reason: 'Executor has no systemd user manager' })
    expect(computers.computers.find(computer => computer.label === 'laptop'))
      .toMatchObject({ ready: true, running: [older.ticketId], slotsUsed: 1, slotsTotal: 1 })
    expect(computers.queue).toContainEqual({ ticketId: host.id, priority: 'normal', priorityReason: 'normal',
      position: 1, reason: host.message })

    f.finish(sibling.id, 0, 'Cloud slice completed.\n')
    await f.ci.dispatch()
    expect((await read()).partitions!.find(run => run.id === host.id)).toEqual(host)
    readiness.laptop = false
    f.finish(older.ticketId, 0, 'Older integration completed.\n')
    await f.ci.dispatch()
    const unready = (await read()).partitions!.find(run => run.id === host.id)!
    expect(unready).toMatchObject({ state: 'queued',
      message: 'Waiting for a build computer: this integration slice needs one; laptop: Log in to GitHub.' })
    expect((await f.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record).toEqual(unready)
    await f.ci.dispatch()
    expect((await read()).partitions!.find(run => run.id === host.id)).toEqual(unready)

    readiness.laptop = true
    await f.ci.dispatch()
    const running = (await read()).partitions!.find(run => run.id === host.id)!
    expect(running).toMatchObject({ state: 'running', computer: { label: 'laptop' }, message: null })
    expect((await f.pool.query('select record from ci_runs where id=$1', [host.id])).rows[0].record).toEqual(running)
  } finally { await f.close() }
})

it('uses every cloud slot for ordinary integration files and persists throughput weights through authenticated MCP', async () => {
  const f = await fixture({ cloud: { github: 4, circleci: 4 } })
  f.computers.splice(0, 2)
  const files = [
    ...Array.from({ length: 256 }, (_, index) => `apps/api/test/ordinary-${index}.integration.test.ts`),
    'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    'apps/api/test/workflow-systemd-restart.integration.test.ts',
  ]
  const durations = Object.fromEntries(files.map(file => [file, 1000]))
  try {
    const circle = f.computers.filter(computer => computer.hostRef.provider === 'circleci')
    for (const [index, seconds] of [[0, 200], [1, 400]] as const) {
      const computer = circle[index]!
      const finishedAt = new Date(Date.now() - 60_000).toISOString()
      const startedAt = new Date(Date.parse(finishedAt) - seconds * 1000).toISOString()
      const history = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: f.workspaceId,
        suite: 'integration', commit: 'b'.repeat(40), repository: 'octo/site',
        partition: { index: index + 1, count: 3, weights: [100, 1, 1], hostIndexes: [0] },
        groupId: randomUUID(), state: 'passed', step: 'integration', exitCode: 0, message: null,
        computer: { hostRef: computer.hostRef, label: computer.label }, queuedAt: startedAt, startedAt, finishedAt,
        initiator: { principalId: 'principal-history', executionId: null } })
      await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
        values($1,$2,$3,'passed',$4::jsonb)`, [history.id, f.workspaceId, history.groupId, JSON.stringify(history)])
    }
    for (const file of files) {
      await f.pool.query('insert into ci_file_durations(repository,file,duration_ms) values($1,$2,$3)',
        ['octo/site', file, durations[file]])
    }
    const input = { suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40),
      partitions: 8, commandId: 'cloud-integration' }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect(f.published).toHaveLength(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    await f.ci.dispatch()
    expect(f.started).toHaveLength(8)
    expect(new Set(f.started.map(value => value.computer)).size).toBe(8)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    const slices = f.started.map(({ request }) => {
      if (request.operation !== 'start') throw new Error('Expected a start request')
      expect(request.partition?.hostIndexes).toBeUndefined()
      return integrationPartition(request.files!, request.durations!, request.partition!)
    })
    expect(slices.flat().sort()).toEqual([...files].sort())
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(8)
    const faster = read.partitions!.find(run => run.computer?.label === circle[0]!.label)!
    const slower = read.partitions!.find(run => run.computer?.label === circle[1]!.label)!
    const weights = faster.partition!.weights!
    expect(weights[faster.partition!.index]! / weights[slower.partition!.index]!).toBeCloseTo(2, 1)
    const work = (run: typeof faster) => integrationPartition(run.files, durations, run.partition!).length
    expect(work(faster) / work(slower)).toBeGreaterThan(1.7)
    expect(work(faster) / work(slower)).toBeLessThan(2.3)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud' } } })
      expect(run.partition?.weights).toEqual(weights)
      expect((await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record).toEqual(run)
      f.finish(run.id, 0, 'Cloud integration completed.\n')
    }
    await f.ci.dispatch()
    const finished = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(finished.partitions!.every(run => run.state === 'passed')).toBe(true)
  } finally { await f.close() }
})

it('runs an ordinary unpartitioned integration selection on cloud without a build computer', async () => {
  const f = await fixture({ cloud: true })
  f.computers.splice(0, 2)
  try {
    const files = ['apps/api/test/agent-chat.integration.test.ts']
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40), commandId: 'ordinary-integration',
    }))
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ state: 'running', files, partition: null,
      computer: { hostRef: { kind: 'cloud' } } })
  } finally { await f.close() }
})

it('keeps every selected file in a nonempty slice when most files require user systemd', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  f.computers.splice(0, 2)
  const systemd = [
    'apps/api/test/native-service-restart.integration.test.ts',
    'apps/api/test/workflow-systemd-restart-active.integration.test.ts',
  ]
  const ordinary = 'apps/api/test/agent-chat.integration.test.ts'
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', files: [...systemd, ordinary], commit: 'a'.repeat(40),
      partitions: 3, commandId: 'mostly-systemd',
    }))
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    const slices = read.partitions!.map(run => integrationPartition(run.files, {}, run.partition!))
    expect(slices.every(slice => slice.length === 1)).toBe(true)
    expect(slices.flat().sort()).toEqual([...systemd, ordinary].sort())
    expect(read.partitions!.filter(run => run.state === 'queued')).toHaveLength(2)
    expect(read.partitions!.filter(run => run.state === 'running')).toHaveLength(1)
    expect(f.started[0]).toMatchObject({ computer: 'CircleCI 1',
      request: { partition: { index: 2, hostIndexes: [0, 1] } } })
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

it('fails a ticket at once with the reason when the public mirror refuses its commit', async () => {
  const f = await fixture({ github: { laptop: false, builder: false }, cloud: { github: 1, circleci: 0 } })
  try {
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      if (computer.hostRef.kind === 'cloud' && input.operation === 'start') {
        throw new DomainError('CI_MIRROR_PRIVATE_DATA', 'Not published to the public CI mirror: test/example.test.ts:3', 409)
      }
      return request(computer, input)
    }
    const run = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'private' }))
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: run.ticketId }))
    expect(read.run).toMatchObject({ state: 'failed', message: expect.stringContaining('test/example.test.ts:3') })
    await f.ci.dispatch()
    expect(f.started).toHaveLength(0)
  } finally { await f.close() }
})

it('runs two host-only tickets on one computer and queues a third through authenticated MCP', async () => {
  const f = await fixture({ hostSlots: 2, cloud: true })
  f.computers.splice(1, 1)
  try {
    const request = { suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      files: [[...userSystemdIntegrationFiles][0]!] }
    const denied = await f.connect([...CI_GET_ACTIONS])
    expect((await f.call(denied, 'ci_run', { ...request, commandId: randomUUID() })).isError).toBe(true)
    const tickets = []
    for (let index = 0; index < 3; index++) {
      tickets.push(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run',
        { ...request, commandId: randomUUID() })).ticketId)
    }
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    expect(f.started.every(start => start.computer === f.computers[0]!.label)).toBe(true)
    const records = await Promise.all(tickets.map(ticketId => f.value(f.operator, 'ci_get', { ticketId })))
    expect(records.map(record => CiGetOutputSchema.parse(record).run.state)).toEqual(['running', 'running', 'queued'])
    expect(CiGetOutputSchema.parse(records[2]).run.message).toContain('all CI slots in use (2/2)')
    const listed = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(listed.computers[0]).toMatchObject({ slotsUsed: 2, slotsTotal: 2, running: tickets.slice(0, 2) })
    expect(listed.computers.find(computer => computer.hostRef.kind === 'cloud'))
      .toMatchObject({ slotsUsed: 0, slotsTotal: 1 })
    await f.value(f.operator, 'ci_cancel', { ticketId: tickets[0] })
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: tickets[2] })).run.state).toBe('running')
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: tickets[1] })).run.state).toBe('running')
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

it('lists persisted active tickets on their assigned computers even when host status has no runs', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  try {
    const denied = await f.connect(['workflows:read'])
    expect((await f.call(denied, 'ci_computers_list', {})).isError).toBe(true)
    await f.value(f.operator, 'ci_run', { suite: 'integration', scope: 'full', partitions: 5,
      commandId: 'computer-readback' })
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      const reply = await request(computer, input)
      if (reply.operation === 'start' && computer.hostRef.provider === 'circleci') {
        return { ...reply, run: { ...reply.run, state: 'starting' } }
      }
      return reply.operation === 'status' ? { ...reply, runs: [] } : reply
    }
    await f.ci.dispatch()
    expect(f.started).toHaveLength(4)
    const read = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    for (const computer of f.computers) {
      const assigned = f.started.filter(start => start.computer === computer.label)
        .map(start => start.request.operation === 'start' ? start.request.runId : '')
      expect(read.computers.find(value => value.label === computer.label)?.running).toEqual(assigned)
    }
    const first = f.started[0]!
    if (first.request.operation !== 'start') throw new Error('Expected a start request')
    await f.value(f.operator, 'ci_cancel', { ticketId: first.request.runId })
    const afterCancel = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(afterCancel.computers.find(value => value.label === first.computer)?.running).toEqual([])
  } finally { await f.close() }
})

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
  try {
    const tickets = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'full', partitions: 2, commandId: 'cancel-unstarted',
    }))
    const started = { ticketId: tickets.partitions![1]!.ticketId }
    await f.ci.dispatch()
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
    expect(await f.value(f.operator, 'ci_cancel', { ticketId: started.ticketId }))
      .toMatchObject({ run: { state: 'canceled' } })
    release()
    await dispatch
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run.state).toBe('canceled')
    expect((await f.pool.query('select record from ci_runs where id=$1', [started.ticketId])).rows[0].record)
      .toEqual(read.run)
    expect(f.started).toHaveLength(1)
  } finally { release(); await f.close() }
})

it('prefers build computers and CircleCI over higher-priority GitHub slots for integration', async () => {
  const f = await fixture({ cloud: { github: 2, circleci: 2 } })
  try {
    for (const computer of f.computers) {
      if (computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'github') computer.priority = 100
    }
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'integration-preference', partitions: 4,
    }))
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(4)
    expect(read.partitions!.filter(run => run.computer?.hostRef.kind === 'device')).toHaveLength(2)
    expect(read.partitions!.filter(run => run.computer?.hostRef.provider === 'circleci')).toHaveLength(2)
    expect(read.partitions!.every(run => run.state === 'running')).toBe(true)
    const fallback = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'integration-fallback', partitions: 3,
    }))
    await f.ci.dispatch()
    const fallbackRead = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: fallback.ticketId }))
    const hostSlice = fallbackRead.partitions!.find(run => run.partition!.index === 0)!
    expect(hostSlice).toMatchObject({ state: 'queued', computer: null,
      message: expect.stringContaining('Waiting for a build computer') })
    expect(fallbackRead.partitions!.filter(run => run.id !== hostSlice.id).every(run => run.state === 'running'
      && run.computer?.hostRef.provider === 'github')).toBe(true)
    f.finish(read.partitions!.find(run => run.computer?.hostRef.kind === 'device')!.id, 0, 'Host slice completed.\n')
    await f.ci.dispatch()
    const running = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: fallback.ticketId }))
    expect(running.partitions!.every(run => run.state === 'running')).toBe(true)
    expect(running.partitions!.find(run => run.id === hostSlice.id))
      .toMatchObject({ computer: { hostRef: { kind: 'device' } }, message: null })
  } finally { await f.close() }
})

it.each(['typecheck', 'lint', 'build', 'unit'] as const)(
  'reserves GitHub slots for queued %s parts behind a large integration run', async suite => {
    const f = await fixture({ cloud: { github: 20, circleci: 2 } })
    try {
      const available = f.computers.splice(0)
      const reader = await f.connect(CI_GET_ACTIONS)
      expect((await f.call(reader, 'ci_run', { suite, commandId: 'denied-dispatch' })).isError).toBe(true)
      expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
      const integration = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite: 'integration', commandId: 'integration-backlog', partitions: 32,
      }))
      await f.ci.dispatch()
      const checks = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite, commandId: 'queued-checks',
      }))
      await f.ci.dispatch()
      expect(f.started).toHaveLength(0)
      f.computers.push(...available)
      await f.ci.dispatch()
      const dispatched = (await f.pool.query<{ record: unknown }>(
        'select record from ci_runs where group_id=(select group_id from ci_runs where id=$1)',
        [integration.ticketId])).rows
        .map(row => CiRunRecordSchema.parse(row.record))
      expect(dispatched.filter(run => run.computer?.hostRef.provider === 'github')).toHaveLength(16)
      const integrationRead = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
        ticketId: integration.ticketId,
      }))
      const checksRead = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: checks.ticketId }))
      const integrationLimit = checksRead.partitions!.some(run => run.state === 'queued') ? 16 : 18
      expect(integrationRead.partitions!.filter(run => run.computer?.hostRef.provider === 'github'))
        .toHaveLength(integrationLimit)
      expect(integrationRead.partitions!.filter(run => run.computer?.hostRef.provider === 'circleci')).toHaveLength(2)
      expect(checksRead.partitions!.filter(run => run.state === 'running'))
        .toHaveLength(Math.min(4, checksRead.partitions!.length))
      expect(checksRead.partitions!.filter(run => run.state === 'running').every(run =>
        run.computer?.hostRef.kind === 'cloud' && run.computer.hostRef.provider === 'github')).toBe(true)
      expect(integrationRead.partitions!.some(run => run.state === 'queued')).toBe(true)
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
        [checksRead.run.groupId])).rows
      expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(checksRead.partitions!))
      await f.ci.dispatch()
      const next = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: integration.ticketId }))
      expect(next.partitions!.filter(run => run.computer?.hostRef.provider === 'github')).toHaveLength(integrationLimit)
    } finally { await f.close() }
  },
)

it('dispatches queued typecheck parts beyond the first fifty integration partitions', async () => {
  const f = await fixture({ cloud: { github: 20, circleci: 2 } })
  try {
    const available = f.computers.splice(0)
    for (const commandId of ['integration-first', 'integration-second']) {
      await f.value(f.operator, 'ci_run', { suite: 'integration', commandId, partitions: 32 })
      await f.ci.dispatch()
    }
    const checks = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'typecheck', commandId: 'typecheck-after-backlog',
    }))
    await f.ci.dispatch()
    f.computers.push(...available)
    await f.ci.dispatch()
    const stored = (await f.pool.query<{ record: unknown }>(
      'select record from ci_runs where group_id=(select group_id from ci_runs where id=$1)',
      [checks.ticketId])).rows.map(row => CiRunRecordSchema.parse(row.record))
    expect(stored).toHaveLength(2)
    expect(stored.every(run => run.state === 'running' && run.computer?.hostRef.provider === 'github')).toBe(true)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: checks.ticketId }))
    expect(read.partitions).toEqual(expect.arrayContaining(stored))
  } finally { await f.close() }
})

it.each([false, true])('requires a high-priority grant for Agents (granted: %s)', async priorityGrant => {
  const f = await fixture({ agent: true, priorityGrant })
  try {
    f.computers.splice(0)
    const input = { suite: 'install', priority: 'high', commandId: 'agent-high-priority' }
    const result = await f.call(f.agent!, 'ci_run', input)
    if (!priorityGrant) {
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
      expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
      expect((await f.pool.query("select outcome from management_audit where action='ci_run'")).rows)
        .toContainEqual({ outcome: 'denied' })
      const normal = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', {
        suite: 'install', commandId: 'agent-normal-priority',
      }))
      expect(CiGetOutputSchema.parse(await f.value(f.agent!, 'ci_get', { ticketId: normal.ticketId })).run)
        .toMatchObject({ priority: 'normal', priorityReason: 'normal' })
    } else {
      expect(result.isError).not.toBe(true)
      const started = CiRunOutputSchema.parse(decodeMcpToolResult(result))
      expect(CiGetOutputSchema.parse(await f.value(f.agent!, 'ci_get', { ticketId: started.ticketId })).run)
        .toMatchObject({ priority: 'high', priorityReason: 'requested' })
      const replay = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', input))
      expect(replay).toEqual(started)
      expect((await f.pool.query("select details->>'priority' as priority from management_audit where action='ci.priority'"))
        .rows).toEqual([{ priority: 'high' }])
      await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'another-caller' })
      const listed = CiComputersOutputSchema.parse(await f.value(f.agent!, 'ci_computers_list', {}))
      expect(listed.queue).toEqual([{ ticketId: started.ticketId, priority: 'high', priorityReason: 'requested',
        position: 1, reason: expect.any(String) }])
      await f.pool.query(`update management_principals set grants=(select jsonb_agg(
        jsonb_set(grant_entry,'{actions}',(select jsonb_agg(action) from jsonb_array_elements(grant_entry->'actions') action
          where action <> '"jobs:prioritize"'::jsonb))) from jsonb_array_elements(grants) grant_entry) where id=$1`,
      [f.authorizationPrincipalId])
      expect((await f.call(f.agent!, 'ci_run', input)).isError).toBe(true)
    }
  } finally { await f.close() }
})

it.each([
  { changedFiles: ['scripts/test-db.mjs'], priority: 'high', priorityReason: 'ci-infrastructure' },
  { changedFiles: ['scripts/test-db.mjs', 'apps/web/src/App.tsx'], priority: 'normal', priorityReason: 'normal' },
])('derives $priority priority from actual commit changes through Agent MCP', async expected => {
  const f = await fixture({ agent: true, changedFiles: expected.changedFiles })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', {
      suite: 'lint', commandId: 'commit-priority', commit: 'b'.repeat(40), scope: 'affected',
      files: ['apps/api/src/modules/ci-host/service.ts', 'packages/contracts/src/ciHost.ts'],
    }))
    const read = CiGetOutputSchema.parse(await f.value(f.agent!, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ priority: expected.priority, priorityReason: expected.priorityReason })
    expect(read.partitions?.every(run => run.priority === expected.priority)).toBe(true)
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record
    expect(CiRunRecordSchema.parse(stored)).toEqual(read.run)
    expect((await f.pool.query("select details from management_audit where action='ci.priority'")).rows)
      .toEqual([{ details: expect.objectContaining({ priority: expected.priority,
        priorityReason: expected.priorityReason, requestedPriority: 'normal' }) }])
  } finally { await f.close() }
})

it('shows priority and global queue position through MCP and admits high tickets beyond fifty older tickets', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  try {
    const available = f.computers.splice(0)
    const older: string[] = []
    for (let index = 0; index < 51; index++) {
      const ticket = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite: 'install', commandId: `normal-backlog-${index}`,
      }))
      older.push(ticket.ticketId)
    }
    const input = { suite: 'install', commandId: 'operator-high', priority: 'high' }
    const high = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(high)
    expect((await f.call(f.operator, 'ci_run', { ...input, priority: 'normal' })).isError).toBe(true)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: high.ticketId }))
    expect(read.run).toMatchObject({ state: 'queued', priority: 'high', priorityReason: 'requested' })
    expect(read.queue).toMatchObject({ position: 1, reason: expect.any(String) })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: older[0] })).queue?.position).toBe(2)
    const computers = CiComputersOutputSchema.parse(await f.value(f.operator, 'ci_computers_list', {}))
    expect(computers.queue?.[0]).toEqual({ ticketId: high.ticketId, priority: 'high', priorityReason: 'requested',
      position: 1, reason: read.queue!.reason })
    expect(computers.queue).toHaveLength(52)
    expect(computers.queueTruncated).toBe(false)
    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied, 'ci_run', { suite: 'install', commandId: 'denied-high', priority: 'high' })).isError)
      .toBe(true)
    f.computers.push(...available)
    await f.ci.dispatch()
    expect(f.started[0]?.request).toMatchObject({ runId: high.ticketId })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: high.ticketId })).queue).toBeNull()
  } finally { await f.close() }
})

it('lets high integration tickets use cloud slots reserved for normal checks', async () => {
  const f = await fixture({ cloud: { github: 2, circleci: 0 } })
  try {
    const available = f.computers.splice(0).filter(computer => computer.hostRef.kind === 'cloud')
    await f.value(f.operator, 'ci_run', { suite: 'lint', commandId: 'normal-checks' })
    const integration = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', commit: 'a'.repeat(40), partitions: 2,
      files: ['apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts'],
      commandId: 'high-integration', priority: 'high',
    }))
    await f.ci.dispatch()
    f.computers.push(...available)
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: integration.ticketId }))
    expect(read.partitions!.every(run => run.priority === 'high' && run.state === 'running')).toBe(true)
    expect(f.started).toHaveLength(2)
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


it.each(['full', 'affected'] as const)('automatically sizes %s integration via MCP with estimates and persisted readback', async scope => {
  const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/timed-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 120_000]))
  const f = await fixture({ integrationInventory: { files, durations }, cloud: { github: 16, circleci: 28 } })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope, commit: 'a'.repeat(40), commandId: `automatic-${scope}`,
      ...(scope === 'affected' ? { files: files.slice(0, 6) } : {}) }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(scope === 'full' ? 10 : 3)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions!.every(run => run.expectedDurationMs === 330_000)).toBe(true)
    expect(read.partitions!.every(run => run.computer?.hostRef.kind === 'cloud')).toBe(true)
    const selected = scope === 'full' ? files : files.slice(0, 6)
    const slices = read.partitions!.map(run => integrationPartition(selected, durations, run.partition!))
    expect(slices.flat().sort()).toEqual([...selected].sort())
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)
    expect(stored).toEqual(expect.arrayContaining(read.partitions!))
    for (const run of read.partitions!) f.finish(run.id, 0, 'passed')
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId })).group?.state)
      .toBe('passed')
  } finally { await f.close() }
})

it('supersedes every queued and running part through MCP and preserves the replacement across retries', async () => {
  const oldCommit = 'a'.repeat(40)
  const nextCommit = 'b'.repeat(40)
  const f = await fixture({ supersession: {
    branch: () => 'feature', isAncestor: (ancestor, commit) => ancestor === oldCommit && commit === nextCommit,
  } })
  f.computers.splice(1)
  const canceled: string[] = []
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input) => {
    const reply = await request(computer, input)
    if (input.operation === 'cancel') canceled.push(input.runId)
    return reply
  }
  try {
    const tools = await f.operator.listTools()
    expect(tools.tools.find(tool => tool.name === 'ci_run')?.annotations?.destructiveHint).toBe(true)
    const old = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'typecheck', commit: oldCommit, commandId: 'old-checks',
    }))
    const before = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: old.ticketId }))
    expect(before.partitions!.map(run => run.state).sort()).toEqual(['queued', 'running'])
    const input = { suite: 'typecheck', commit: nextCommit, commandId: 'replacement-checks' }
    const denied = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['another-workspace'] })
    expect((await f.call(denied, 'ci_run', input)).isError).toBe(true)
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: old.ticketId })).partitions!)
      .toEqual(before.partitions)
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: old.ticketId }))
    expect(read.partitions).toHaveLength(2)
    for (const part of read.partitions!) {
      expect(part).toMatchObject({ state: 'canceled', supersededBy: next.ticketId,
        message: `superseded by ${next.ticketId}` })
      expect(part.finishedAt).not.toBeNull()
    }
    expect(canceled).toEqual([before.partitions!.find(run => run.state === 'running')!.id])
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(next)
    expect(canceled).toHaveLength(1)
    const persisted = (await f.pool.query<{ record: unknown; host_key: string | null }>(
      'select record,host_key from ci_runs where group_id=$1', [read.run.groupId])).rows
    expect(persisted.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
    expect(persisted.every(row => row.host_key === null)).toBe(true)
    expect((await f.pool.query(`select details from management_audit where action='ci.supersede'`)).rows)
      .toHaveLength(2)
    expect((await f.pool.query(`select outcome from management_audit where action='ci_run'`)).rows)
      .toContainEqual({ outcome: 'denied' })
    const replacement = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: next.ticketId }))
    expect(replacement.partitions!.some(run => run.state === 'running')).toBe(true)
  } finally { await f.close() }
})

it('keeps main, explicit keep, unrelated branch, suite, requester and non-descendant tickets through MCP', async () => {
  const commits = ['a', 'b', 'c', 'd', 'e', 'f'].map(char => char.repeat(40))
  const f = await fixture({ supersession: {
    branch: commit => commit === commits[0] ? 'main' : commit === commits[2] ? 'other-feature' : 'feature',
    isAncestor: (ancestor, commit) => commit === '1'.repeat(40) && ancestor !== commits[4],
  } })
  f.computers.splice(0)
  try {
    const tickets: string[] = []
    for (const [index, commit] of commits.entries()) {
      tickets.push(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite: index === 5 ? 'build' : 'typecheck', commit,
        noSupersede: index === 1, commandId: `protected-${index}`,
      })).ticketId)
    }
    const other = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const foreign = CiRunOutputSchema.parse(await f.value(other, 'ci_run', {
      suite: 'typecheck', commit: commits[3], commandId: 'another-requester',
    }))
    const noCancel = await f.connect(CI_RUN_ACTIONS.filter(action => action !== 'jobs:cancel'))
    expect((await f.call(noCancel, 'ci_run', {
      suite: 'typecheck', commit: '1'.repeat(40), commandId: 'missing-cancel-grant',
    })).isError).toBe(true)
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'typecheck', commit: '1'.repeat(40), commandId: 'latest-checks',
    }))
    for (const [index, ticketId] of tickets.entries()) {
      const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId }))
      if (index === 3) {
        expect(read.run).toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
      } else {
        expect(read.run.state).toBe('queued')
        expect(read.run.supersededBy).toBeUndefined()
      }
      if (index === 1) expect(read.run.noSupersede).toBe(true)
    }
    expect(CiGetOutputSchema.parse(await f.value(other, 'ci_get', { ticketId: foreign.ticketId })).run.state)
      .toBe('queued')
  } finally { await f.close() }
})

it('retries superseded running cleanup before releasing its computer slot', async () => {
  const f = await fixture({ supersession: { branch: () => 'feature', isAncestor: () => true } })
  f.computers.splice(1)
  const request = f.endpoint.request.bind(f.endpoint)
  let offline = false
  f.endpoint.request = async (computer, input) => {
    if (offline && input.operation === 'cancel') throw new DomainError('CI_COMPUTER_OFFLINE', 'Offline.', 409)
    return request(computer, input)
  }
  try {
    const old = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'a'.repeat(40), commandId: 'cleanup-old',
    }))
    await f.ci.dispatch()
    offline = true
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'b'.repeat(40), commandId: 'cleanup-next',
    }))
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: old.ticketId })).run)
      .toMatchObject({ state: 'running', supersededBy: next.ticketId })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: next.ticketId })).run.state)
      .toBe('queued')
    expect(f.started).toHaveLength(1)
    offline = false
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: old.ticketId })).run)
      .toMatchObject({ state: 'canceled', message: `superseded by ${next.ticketId}` })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: next.ticketId })).run.state)
      .toBe('running')
  } finally { await f.close() }
})

it('supersedes detached Agent commits only within that execution through authenticated MCP', async () => {
  const f = await fixture({ agent: true, supersession: { branch: () => null, isAncestor: () => true } })
  f.computers.splice(0)
  try {
    const call = async (input: Record<string, unknown>, client = f.agent!) => {
      const result = await client.callTool({ name: 'ci_run', arguments: input })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return CiRunOutputSchema.parse(decodeMcpToolResult(result))
    }
    const old = await call({ suite: 'install', commit: 'a'.repeat(40), commandId: 'agent-old' })
    const operator = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'a'.repeat(40), commandId: 'operator-detached',
    }))
    const renewed = await f.connectAgent!()
    const next = await call({ suite: 'install', commit: 'b'.repeat(40), commandId: 'agent-next' }, renewed)
    const read = await f.agent!.callTool({ name: 'ci_get', arguments: { ticketId: old.ticketId } })
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(read)).run)
      .toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
    const replacement = await renewed.callTool({ name: 'ci_get', arguments: { ticketId: next.ticketId } })
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(replacement)).run.initiator.principalId)
      .not.toBe(CiGetOutputSchema.parse(decodeMcpToolResult(read)).run.initiator.principalId)
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: operator.ticketId })).run.state)
      .toBe('queued')
    const denied = await f.agent!.callTool({ name: 'ci_get', arguments: { ticketId: operator.ticketId } })
    expect(denied.isError).toBe(true)
  } finally { await f.close() }
})

it('resolves branches of existing tickets before superseding them and protects existing main work', async () => {
  const f = await fixture({ supersession: {
    branch: commit => commit === 'a'.repeat(40) ? 'main' : 'feature', isAncestor: () => true,
  } })
  f.computers.splice(0)
  try {
    const main = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'a'.repeat(40), commandId: 'existing-main',
    }))
    const feature = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'b'.repeat(40), commandId: 'existing-feature',
    }))
    await f.pool.query(`update ci_runs set record=record-'branch'-'defaultBranch' where id=any($1::uuid[])`,
      [[main.ticketId, feature.ticketId]])
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'c'.repeat(40), commandId: 'supersede-existing',
    }))
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: main.ticketId })).run.state)
      .toBe('queued')
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: feature.ticketId })).run)
      .toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
  } finally { await f.close() }
})

it('targets one smoke computer through authenticated MCP and HTTP with grants, retries and persisted readback', async () => {
  const f = await fixture({ cloud: { github: 1, circleci: 1 } })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      files: ['apps/api/test/ci-smoke.integration.test.ts'], noSupersede: true }
    for (const [index, computer] of f.computers.entries()) {
      const request = { ...input, smokeComputer: computer.hostRef, commandId: `smoke-${index}` }
      expect((await f.call(reader, 'ci_run', request)).isError).toBe(true)
      const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', request))
      expect(started.partitions).toBeUndefined()
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', request))).toEqual(started)
      const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
      expect(read.run.computer?.hostRef).toEqual(computer.hostRef)
      expect(read.run).toMatchObject({ smokeComputer: computer.hostRef, integrationShards: 11 })
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
        [started.ticketId])).rows[0]!.record
      const { smokeComputer: _target, ...retainedReleaseShape } = CiRunRecordSchema.shape
      expect((await import('zod')).z.object(retainedReleaseShape).strict().safeParse(stored).success).toBe(true)
      f.finish(started.ticketId, 0, 'one test passed')
      expect(CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId })).run.state)
        .toBe('passed')
    }
    const token = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const response = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${f.workspaceId}/ci`,
      headers: { authorization: `Bearer ${token.token}` },
      payload: { ...input, commandId: 'http-smoke', smokeComputer: f.computers[1]!.hostRef } })
    expect(response.statusCode, response.body).toBe(200)
    const ticket = CiRunOutputSchema.parse(response.json())
    await f.ci.dispatch()
    const httpRead = await f.app.inject({ url: `/api/management/workspaces/${f.workspaceId}/ci/${ticket.ticketId}`,
      headers: { authorization: `Bearer ${token.token}` } })
    expect(httpRead.json().run.smokeComputer).toEqual(f.computers[1]!.hostRef)
    expect(httpRead.json().run.computer.hostRef).toEqual(f.computers[1]!.hostRef)
  } finally { await f.close() }
})

it('rejects Agent smoke targeting and never falls back to another computer when a target is unavailable', async () => {
  const f = await fixture({ agent: true })
  try {
    const request = { suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      files: ['apps/api/test/ci-smoke.integration.test.ts'], commandId: 'smoke-denied',
      smokeComputer: f.computers[0]!.hostRef }
    expect((await f.agent!.callTool({ name: 'ci_run', arguments: request })).isError).toBe(true)
    const computer = f.computers.shift()!
    expect((await f.call(f.operator, 'ci_run', request)).isError).toBe(true)
    expect(f.started).toHaveLength(0)
    f.computers.push(computer)
    const endpointRequest = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (target, input) => {
      if (input.operation === 'start' && target.key === computer.key) {
        throw new DomainError('CI_HOST_BUSY', 'Target is busy.', 409)
      }
      return endpointRequest(target, input)
    }
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { ...request, commandId: 'smoke-busy' }))
    const queued = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(queued.run.state).toBe('queued')
    f.computers.pop()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run.state).toBe('queued')
    expect(read.run.computer).toBeNull()
    expect(f.started).toHaveLength(0)
  } finally { await f.close() }
})
