import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { BuildComputerSettings } from '../src/modules/settings/buildComputers.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { JobComputerSelection, releaseUnstartedJobComputer } from '../src/modules/jobs/computerSelection.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { JobService } from '../src/modules/jobs/service.js'
import { DomainError } from '../src/modules/errors.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { buildComputerFixture } from './helpers/buildComputerFixture.js'
import { JobDefinitionSchema, JobExecutionSchema, type JobDefinition, type ResolvedJobDefinitionSpec } from '@graphql/contracts/jobs'

// Real settings/command/admission SQL and authenticated transports; runtime/source I/O is a bounded fixture.
describe.skipIf(!postgresEnabled)('automatic build computer admission and settings parity', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let commands: PostgresCommandCoordinator
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let mainId: string
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeAll(async () => {
    database = await agent3Database()
    mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    access = new PostgresAccessService(database.pool)
    commands = new PostgresCommandCoordinator(database.pool)
    const grants = ['settings:read', 'settings:update', 'job_definitions:read', 'job_definitions:write',
      'jobs:start', 'jobs:read', 'jobs:cancel', 'job_artifacts:read', 'capabilities:read'] as const
    writer = await access.issue({ name: 'Build settings writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: [...grants], scope: {} }] })
    reader = await access.issue({ name: 'Build settings reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read', 'jobs:read', 'capabilities:read'], scope: {} }] })
  }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await Promise.allSettled(apps.map(app => app.close()))
    await database?.close()
  })
  async function fixture(options: { startupEnabled?: boolean } = {}) {
    const workspaceId = randomUUID()
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Build selection fixture' })])
    const computers = [0, 1, 2].map(() => buildComputerFixture(mainId, workspaceId))
    for (const computer of computers) await database.pool.query(`insert into device_registrations
      (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
    [computer.registration.deviceId, mainId, computer.registration.workerInstallationId, JSON.stringify(computer.registration)])
    const settings = new BuildComputerSettings(database.pool, commands, async () => ({
      state: 'ready', reasons: [], remoteExecutionEnabled: options.startupEnabled ?? true,
    }))
    const inventory = { candidates: vi.fn(async () => computers.map(computer => computer.candidate)) }
    const workerExecution = new WorkerExecutionPolicy({ enabled: options.startupEnabled ?? true, managedBy: 'startup' })
    const placement = new JobComputerSelection(settings, inventory, workerExecution)
    const accept = vi.fn(async (_sql: JobSql, _principal: ManagementPrincipal, _workspace: string, spec: ResolvedJobDefinitionSpec) => ({
      ...spec, source: { ...spec.source, materializationId: randomUUID(), materializationDigest: '1'.repeat(64) },
    }))
    const jobs = new JobService(database.pool, commands, { placement, workerExecution,
      preparation: { accept, choices: async () => ({ targets: [], sources: [], policies: [] }),
        validate: async () => ({ valid: true, reasons: [], sideEffects: false }),
        revalidateAccepted: async () => {}, adoptFinalBinding: async () => {} },
      dispatch: { accept: async (_sql, input) => ({ operationId: input.operationId, attemptId: input.attemptId,
        owner: { grantId: randomUUID(), epoch: '1' } }), wake: async () => {}, cancel: async () => {},
      cancelForRunCleanup: async () => { throw new Error('No Run cleanup in this admission fixture') } },
      artifacts: { list: async () => [], read: async () => { throw new Error('No physical artifact fixture') } },
    })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs, buildComputers: settings, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'build-computer-tests', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    async function enroll(index: number, enabled: boolean, priority: number) {
      const target = computers[index]!.target
      const current = await settings.read(writer.principal, { target })
      return settings.update(writer.principal, 'http', { target, commandId: randomUUID(),
        expectedRevision: current.preference.revision, buildEnabled: enabled, buildPriority: priority })
    }
    async function save(spec = computers[0]!.auto): Promise<JobDefinition> {
      return jobs.saveDefinition(writer.principal, 'http', workspaceId, { commandId: randomUUID(),
        expectedRevision: null, name: 'Automatic build', spec })
    }
    return { workspaceId, computers, settings, inventory, placement, jobs, accept, app, connect, enroll, save }
  }
  it('persists settings through HTTP/MCP, replays one command, conflicts stale writes and denies read-only/scoped callers', async () => {
    const f = await fixture()
    const target = f.computers[0]!.target
    const input = { target, commandId: randomUUID(), expectedRevision: 0, buildEnabled: true, buildPriority: 100 }
    const response = await f.app.inject({ method: 'POST', url: '/api/management/settings/build-computers/update',
      headers: { authorization: `Bearer ${writer.token}` }, payload: input })
    expect(response.statusCode).toBe(200)
    const client = await f.connect(writer.token)
    expect((await client.callTool({ name: 'build_computer_update', arguments: input })).structuredContent).toEqual(response.json())
    expect((await client.callTool({ name: 'build_computer_get', arguments: { target } })).structuredContent).toEqual(response.json())
    const restarted = new BuildComputerSettings(database.pool, commands, async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
    expect(await restarted.read(writer.principal, { target })).toEqual(response.json())
    const stale = await client.callTool({ name: 'build_computer_update', arguments: { ...input, commandId: randomUUID() } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
    const readOnly = await f.connect(reader.token)
    const denied = await readOnly.callTool({ name: 'build_computer_update', arguments: { ...input, commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const scoped = await access.issue({ name: 'Scoped settings', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['settings:update'], scope: { workspaceIds: [f.workspaceId] } }] })
    await expect(f.settings.update(scoped.principal, 'mcp', { ...input, commandId: randomUUID(), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const audit = await database.pool.query("select outcome from management_audit where action='build.computer.update' and principal_id=$1", [writer.principal.id])
    expect(audit.rows.map(row => row.outcome)).toContain('succeeded')
  })
  it('saves Auto offline, chooses by enrollment and priority at Start and preserves accepted facts across edits and retries', async () => {
    const f = await fixture()
    f.computers.forEach(computer => { computer.candidate.ready = false })
    const definition = await f.save()
    expect(f.inventory.candidates).not.toHaveBeenCalled()
    f.computers.forEach(computer => { computer.candidate.ready = true })
    await f.enroll(0, false, 100)
    await f.enroll(1, true, 50)
    await f.enroll(2, true, 100)
    const command = { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }
    const first = await f.jobs.start(writer.principal, 'http', f.workspaceId, command)
    expect(first.acceptedSpec.target).toEqual(f.computers[2]!.candidate.spec.target)
    expect(first.acceptedSpec.policy).toEqual(f.computers[2]!.candidate.spec.policy)
    expect(first.acceptedSpec.computerSelection).toMatchObject({ mode: 'auto', buildPriority: 100 })
    expect(first.acceptedSpec.source).toMatchObject(definition.spec.source)
    await f.enroll(2, false, 0)
    await f.enroll(1, true, 100)
    const retry = await f.jobs.start(writer.principal, 'mcp', f.workspaceId, command)
    expect(retry).toEqual(first)
    expect(f.accept).toHaveBeenCalledTimes(1)
    const second = await f.jobs.start(writer.principal, 'mcp', f.workspaceId, { ...command, commandId: randomUUID() })
    expect(second.acceptedSpec.target).toEqual(f.computers[1]!.candidate.spec.target)
    expect((await f.jobs.getExecution(reader.principal, f.workspaceId, first.id)).acceptedSpec).toEqual(first.acceptedSpec)
  })
  it('saves, starts and reads an Auto Job through authenticated MCP while denying a read-only start', async () => {
    const f = await fixture()
    await f.enroll(0, true, 100)
    const client = await f.connect(writer.token)
    const saved = await client.callTool({ name: 'job_definition_save', arguments: {
      workspaceId: f.workspaceId, commandId: randomUUID(), expectedRevision: null,
      name: 'MCP automatic build', spec: f.computers[0]!.auto,
    } })
    expect(saved.isError).not.toBe(true)
    const { definition } = z.object({ definition: JobDefinitionSchema }).parse(saved.structuredContent)
    const command = { workspaceId: f.workspaceId, commandId: randomUUID(),
      definitionId: definition.id, expectedRevision: definition.revision }
    const readOnly = await f.connect(reader.token)
    const denied = await readOnly.callTool({ name: 'job_start', arguments: command })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(f.accept).not.toHaveBeenCalled()
    const started = await client.callTool({ name: 'job_start', arguments: command })
    expect(started.isError).not.toBe(true)
    const { execution } = z.object({ execution: JobExecutionSchema }).parse(started.structuredContent)
    expect(execution.acceptedSpec.computerSelection).toMatchObject({ mode: 'auto', buildPriority: 100 })
    expect((await client.callTool({ name: 'job_start', arguments: command })).structuredContent).toEqual(started.structuredContent)
    expect((await readOnly.callTool({ name: 'job_get', arguments: {
      workspaceId: f.workspaceId, executionId: execution.id,
    } })).structuredContent).toEqual(started.structuredContent)
    expect((await f.jobs.getExecution(writer.principal, f.workspaceId, execution.id)).acceptedSpec).toEqual(execution.acceptedSpec)
    expect(f.accept).toHaveBeenCalledTimes(1)
  })
  it('fails before preparation with no participants and preserves the startup gate separately', async () => {
    const f = await fixture({ startupEnabled: false })
    const definition = await f.save()
    const start = () => f.jobs.start(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 })
    await expect(start()).rejects.toMatchObject({ code: 'JOB_NO_BUILD_COMPUTER', details: { reasons: ['disabled'] } })
    await f.enroll(0, true, 100)
    await expect(start()).rejects.toMatchObject({ code: 'JOB_NO_BUILD_COMPUTER' })
    expect(f.accept).not.toHaveBeenCalled()
    expect((await database.pool.query('select 1 from job_preparations where workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
  })
  it('rejects stale definition/start revisions and read-only edits through authenticated MCP with persisted readback', async () => {
    const f = await fixture()
    await f.enroll(0, true, 100)
    const definition = await f.save()
    const client = await f.connect(writer.token)
    const readOnly = await f.connect(reader.token)
    const edit = { workspaceId: f.workspaceId, commandId: randomUUID(), id: definition.id,
      expectedRevision: definition.revision, name: 'Updated build', spec: definition.spec }
    const denied = await readOnly.callTool({ name: 'job_definition_save', arguments: edit })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await f.jobs.getDefinition(writer.principal, f.workspaceId, definition.id)).toEqual(definition)
    const updated = await client.callTool({ name: 'job_definition_save', arguments: edit })
    expect(updated.isError).not.toBe(true)
    const saved = updated.structuredContent?.definition as JobDefinition
    expect(saved.revision).toBe(definition.revision + 1)
    const staleEdit = await client.callTool({ name: 'job_definition_save', arguments: {
      ...edit, commandId: randomUUID(),
    } })
    expect(staleEdit.isError).toBe(true)
    expect(JSON.stringify(staleEdit.content)).toContain('REVISION_CONFLICT')
    const staleStart = await client.callTool({ name: 'job_start', arguments: {
      workspaceId: f.workspaceId, commandId: randomUUID(), definitionId: saved.id,
      expectedRevision: definition.revision,
    } })
    expect(staleStart.isError).toBe(true)
    expect(JSON.stringify(staleStart.content)).toContain('REVISION_CONFLICT')
    expect(f.accept).not.toHaveBeenCalled()
    expect((await client.callTool({ name: 'job_definition_get', arguments: {
      workspaceId: f.workspaceId, definitionId: saved.id,
    } })).structuredContent).toEqual(updated.structuredContent)
    const start = { workspaceId: f.workspaceId, commandId: randomUUID(), definitionId: saved.id,
      expectedRevision: saved.revision }
    const accepted = await client.callTool({ name: 'job_start', arguments: start })
    expect(accepted.isError).not.toBe(true)
    const conflict = await client.callTool({ name: 'job_start', arguments: {
      ...start, expectedRevision: definition.revision,
    } })
    expect(conflict.isError).toBe(true)
    expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
    expect(f.accept).toHaveBeenCalledTimes(1)
  })
  it('atomically places concurrent starts on separate available computers and refuses overcommit', async () => {
    const f = await fixture()
    await f.enroll(1, true, 50)
    await f.enroll(2, true, 100)
    const definition = await f.save()
    const started = await Promise.all([0, 1].map(() => f.jobs.start(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 })))
    expect(new Set(started.map(execution => execution.acceptedSpec.target.hostRef.kind === 'device'
      ? execution.acceptedSpec.target.hostRef.deviceId : 'main')).size).toBe(2)
    expect(new Set(started.map(execution => execution.operationId)).size).toBe(2)
    await expect(f.jobs.start(writer.principal, 'mcp', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'JOB_NO_BUILD_COMPUTER' })
    expect(f.accept).toHaveBeenCalledTimes(2)
  })
  it('keeps fixed jobs fixed and requires explicit enrollment', async () => {
    const f = await fixture()
    await f.enroll(2, true, 100)
    const definition = await f.jobs.saveDefinition(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), expectedRevision: null, name: 'Fixed build', spec: f.computers[0]!.candidate.spec })
    f.inventory.candidates.mockImplementation(async () => [f.computers[0]!.candidate])
    await expect(f.jobs.start(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'JOB_BUILD_COMPUTER_UNAVAILABLE' })
    expect(f.accept).not.toHaveBeenCalled()
    await f.enroll(0, true, 1)
    const started = await f.jobs.start(writer.principal, 'mcp', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 })
    expect(started.acceptedSpec.target).toEqual(definition.spec.target)
  })
  it('does not launch or reselect when the bound computer is disabled during preparation', async () => {
    const f = await fixture()
    await f.enroll(0, true, 100)
    await f.enroll(1, true, 50)
    const definition = await f.save()
    f.accept.mockImplementationOnce(async (...args) => {
      await f.enroll(0, false, 100)
      const spec = args[3]
      return { ...spec, source: { ...spec.source, materializationId: randomUUID(), materializationDigest: '1'.repeat(64) } }
    })
    await expect(f.jobs.start(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'BUILD_COMPUTER_DISABLED' })
    const row = (await database.pool.query('select spec,released_at from job_computer_selections where workspace_id=$1', [f.workspaceId])).rows[0]!
    expect(row.spec.target).toEqual(f.computers[0]!.candidate.spec.target)
    expect(row.released_at).not.toBeNull()
    expect(f.accept).toHaveBeenCalledTimes(1)
  })
  it('retains interrupted source reservations and retries only the original selected operation', async () => {
    const f = await fixture()
    await f.enroll(0, true, 100)
    await f.enroll(1, true, 50)
    const definition = await f.save()
    let originalOperation: string | undefined
    f.accept.mockImplementationOnce(async () => {
      const row = (await database.pool.query('select operation_id from job_computer_selections where workspace_id=$1', [f.workspaceId])).rows[0]!
      originalOperation = row.operation_id
      const sql = await database.pool.connect()
      try {
        await sql.query('begin')
        await new PostgresSourceReservations().reserve(sql, { ...f.computers[0]!.candidate.sourceReservation,
          ownerKind: 'materialization', ownerId: originalOperation! })
        await sql.query('commit')
      } finally { sql.release() }
      throw new DomainError('SOURCE_TRANSFER_PENDING', 'Transfer interrupted', 503)
    })
    const command = { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }
    await expect(f.jobs.start(writer.principal, 'http', f.workspaceId, command)).rejects.toMatchObject({ code: 'SOURCE_TRANSFER_PENDING' })
    await f.enroll(1, true, 100)
    const execution = await f.jobs.start(writer.principal, 'mcp', f.workspaceId, command)
    expect(execution.operationId).toBe(originalOperation)
    expect(execution.acceptedSpec.target).toEqual(f.computers[0]!.candidate.spec.target)
    expect((await database.pool.query('select released_at from job_computer_selections where workspace_id=$1', [f.workspaceId])).rows[0]!.released_at).toBeNull()
    await releaseUnstartedJobComputer(database.pool, { executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId })
    expect((await database.pool.query('select released_at from job_computer_selections where workspace_id=$1', [f.workspaceId])).rows[0]!.released_at).toBeNull()
  })
  it('rejects foreign Main and stale installation authority and resets enrollment after reinstallation', async () => {
    const f = await fixture()
    await f.enroll(0, true, 100)
    const computer = f.computers[0]!
    await expect(f.settings.read(writer.principal, { target: { ...computer.target,
      hostRef: { ...computer.target.hostRef, mainId: randomUUID() } } })).rejects.toMatchObject({ code: 'wrong_main' })
    const replaced = { ...computer.registration, workerInstallationId: randomUUID(), keyRevision: 2, authorizationRevision: 2 }
    await database.pool.query('update device_registrations set worker_installation_id=$2,record=$3::jsonb where id=$1',
      [replaced.deviceId, replaced.workerInstallationId, JSON.stringify(replaced)])
    await expect(f.settings.read(writer.principal, { target: computer.target })).rejects.toMatchObject({ code: 'unauthorized' })
    const target = { ...computer.target, applicationInstallationId: replaced.workerInstallationId, keyRevision: 2, authorizationRevision: 2 }
    expect((await f.settings.read(writer.principal, { target })).preference).toMatchObject({ buildEnabled: false, buildPriority: 50 })
  })
  it('binds workflow preparation through the same selector and reads the original selection after owner restart', async () => {
    const f = await fixture()
    await f.enroll(0, true, 100)
    await f.enroll(1, true, 50)
    const definition = await f.save()
    const identity = { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() }
    const sql = await database.pool.connect()
    try {
      await sql.query('begin')
      await f.jobs.resolveDefinition(sql, writer.principal, definition, identity)
      await sql.query('commit')
    } finally { sql.release() }
    await f.enroll(1, true, 100)
    const prepared = await f.jobs.prepareDefinition(database.pool, writer.principal, definition, identity)
    expect(prepared.target).toEqual(f.computers[0]!.candidate.spec.target)
    const restarted = new JobComputerSelection(f.settings, f.inventory, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
    expect(await restarted.prepare(database.pool, definition, identity)).toEqual(f.computers[0]!.candidate.spec)
    await expect(f.jobs.admitPrepared(database.pool, writer.principal, definition,
      { workflowId: randomUUID(), runId: randomUUID(), nodeId: 'build', nodeExecutionId: identity.executionId },
      { request: 'workflow input' }, { ...prepared, target: f.computers[1]!.candidate.spec.target }, identity))
      .rejects.toMatchObject({ code: 'JOB_ACCEPTANCE_PIN_CONFLICT' })
    expect(f.inventory.candidates).toHaveBeenCalledTimes(1)
  })
  it('releases a preparation that never transferred and leaves other reservations charged', async () => {
    const f = await fixture()
    await f.enroll(0, true, 100)
    await f.enroll(1, true, 50)
    const definition = await f.save()
    const running = await f.jobs.start(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 })
    f.accept.mockRejectedValueOnce(new DomainError('JOB_SOURCE_PIN_CONFLICT', 'Source changed before transfer', 409))
    await expect(f.jobs.start(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'JOB_SOURCE_PIN_CONFLICT' })
    const rows = (await database.pool.query<{ execution_id: string; released_at: Date | null }>(
      'select execution_id,released_at from job_computer_selections where workspace_id=$1', [f.workspaceId])).rows
    expect(rows.find(row => row.execution_id === running.id)?.released_at).toBeNull()
    expect(rows.filter(row => row.released_at !== null)).toHaveLength(1)
    const next = await f.jobs.start(writer.principal, 'mcp', f.workspaceId,
      { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 })
    expect(next.acceptedSpec.target).toEqual(f.computers[1]!.candidate.spec.target)
  })
})
