import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkflowRunSchema } from '@graphql/contracts'
import { ManagementActionSchema, RunResumeResultSchema, RunStartResultSchema } from '@graphql/contracts/management'
import { RunStartV2ResultSchema, WorkflowRunV2Schema } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { HarnessConfigurationQualifier } from '../src/modules/harnesses/port.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { OperatorRunControls } from '../src/modules/runs/operatorControls.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { OperatorExtensions } from '../src/mcp/operator/extensions.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('ENG-03 Operator v2 Run controls', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  let app: ReturnType<typeof buildApp>
  let address: string
  let access: PostgresAccessService
  let locations: WorkspaceLocationService
  let resumeEngine: ReturnType<typeof vi.fn>
  const clients: Client[] = []

  beforeAll(async () => {
    db = await agent3Database()
    access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    locations = new WorkspaceLocationService(db.pool, commands, db.directory)
    const workflows = new PostgresWorkflowRepository(db.pool)
    const runs = new PostgresRunRepository(db.pool, workflows, locations)
    resumeEngine = vi.fn(async () => undefined)
    const engine = { start: vi.fn(async () => undefined), resume: resumeEngine } as unknown as LangGraphWorkflowEngine
    const qualifier: HarnessConfigurationQualifier = { async qualify(configuration) {
      return { harness: configuration.harness, version: 'synthetic-no-native-call', authenticated: true, ready: true,
        structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
        supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: ['model'], unsupportedCapabilities: [] }
    } }
    const managedRuns = new RunManagementService(db.pool, commands, runs, engine, locations)
    const extensions = { runs: new OperatorRunControls(db.pool, commands, engine, managedRuns) } as OperatorExtensions
    app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: {
        commands, locations, runs: managedRuns, extensions,
        drafts: new GraphDraftService(db.pool, commands),
        workflows: new WorkflowManagementService(db.pool, commands),
        agents: new AgentManagementService(db.pool),
        workspaces: new WorkspaceManagementService(db.pool, commands, locations),
        harnesses: new HarnessCatalogService(qualifier, new PostgresSettingsRepository(db.pool), commands, db.directory),
      } } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)
  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close(); await db?.close()
  })

  async function connect(token: string) {
    const client = new Client({ name: 'eng03-c-run-controls', version: '1.0.0' })
    try { await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } })) }
    catch (error) { await client.close().catch(() => undefined); throw error }
    clients.push(client)
    return client
  }
  async function fixture() {
    const f = await seedAgent3(db.pool, db.directory)
    const issued = await access.issue({ name: 'ENG-03 C Operator', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }],
      expiresAt: new Date(Date.now() + 300_000) })
    return { f, issued, client: await connect(issued.token) }
  }
  async function call(client: Client, name: string, input: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: input })
    expect(result.isError).not.toBe(true)
    return result.structuredContent
  }
  async function rejected(client: Client, name: string, input: Record<string, unknown>) {
    try {
      const result = await client.callTool({ name, arguments: input })
      expect(result.isError).toBe(true)
    } catch (error) { expect(error).toBeTruthy() }
  }

  it('retries a failed v2 Run with saved v2 admission, exact input, replay, HTTP readback and scoped denial', async () => {
    const { f, issued, client } = await fixture()
    const finished = WorkflowRunV2Schema.parse({ ...f.run, executionState: 'completed', outcome: 'failed',
      result: { outcome: 'failed', error: { code: 'SYNTHETIC_FAILURE', message: 'Task-owned test failure.', retryable: true } },
      finishedAt: new Date().toISOString() })
    await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [f.run.id, 'completed', JSON.stringify(finished)])
    vi.spyOn(locations, 'snapshot').mockResolvedValue(f.run.executionLocation!)
    const input = { workspaceId: f.scope.workspaceId, runId: f.run.id, workflowVersionId: f.version.id,
      expectedLocationRevision: 1, commandId: randomUUID() }
    const result = RunStartV2ResultSchema.parse(await call(client, 'run_retry', input))
    expect(result.accepted).toBe(true)
    expect(result.replayed).toBe(false)
    expect(result.run.id).not.toBe(f.run.id)
    expect(result.run.input).toEqual(f.run.input)
    expect(result.run.executionSemanticsVersion).toBe(2)
    const replay = RunStartV2ResultSchema.parse(await call(client, 'run_retry', input))
    expect(replay.replayed).toBe(true)
    expect(replay.run.id).toBe(result.run.id)
    const enrolled = await app.inject({ method: 'POST', url: '/api/auth/enroll', headers: { host: 'localhost' }, payload: { token: issued.token } })
    expect(enrolled.statusCode).toBe(200)
    const cookie = String(enrolled.headers['set-cookie']).split(';')[0]!
    const read = await app.inject({ method: 'GET', url: `/api/management/workspaces/${f.scope.workspaceId}/runs/${result.run.id}`,
      headers: { host: 'localhost', cookie } })
    expect(read.statusCode).toBe(200)
    expect(WorkflowRunV2Schema.parse(read.json().run)).toEqual(result.run)
    const readOnly = await access.issue({ name: 'ENG-03 C denied Operator', audience: 'operator',
      grants: [{ actions: ['runs:read', 'workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } }],
      expiresAt: new Date(Date.now() + 300_000) })
    await rejected(await connect(readOnly.token), 'run_retry', { ...input, commandId: randomUUID() })
    expect((await db.pool.query<{ count: string }>('select count(*)::text as count from runs where workflow_id=$1', [f.scope.workflowId])).rows[0]!.count).toBe('2')
  })

  it('resumes a v2 Run through the authenticated MCP command boundary exactly once', async () => {
    const { f, client } = await fixture()
    const waiting = WorkflowRunV2Schema.parse({ ...f.run, executionState: 'waiting', startedAt: new Date().toISOString() })
    await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [f.run.id, 'waiting', JSON.stringify(waiting)])
    const input = { workspaceId: f.scope.workspaceId, runId: f.run.id, commandId: randomUUID() }
    const before = resumeEngine.mock.calls.length
    const result = RunResumeResultSchema.parse(await call(client, 'run_resume', input))
    expect(result.value).toEqual({ runId: f.run.id, status: 'reconciled' })
    expect(result.replayed).toBe(false)
    const replay = RunResumeResultSchema.parse(await call(client, 'run_resume', input))
    expect(replay.replayed).toBe(true)
    expect(resumeEngine.mock.calls.length - before).toBe(1)
    const readOnly = await access.issue({ name: 'ENG-03 C resume denied', audience: 'operator',
      grants: [{ actions: ['runs:read', 'workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } }],
      expiresAt: new Date(Date.now() + 300_000) })
    await rejected(await connect(readOnly.token), 'run_resume', { ...input, commandId: randomUUID() })
    expect(resumeEngine.mock.calls.length - before).toBe(1)
    expect((await db.pool.query<{ record: unknown }>('select record from runs where id=$1', [f.run.id])).rows[0]!.record).toEqual(waiting)
  })

  it('keeps retry admission legacy for a saved legacy version', async () => {
    const f = await seedAgent3(db.pool, db.directory, undefined, { run: false, legacy: true })
    const legacy = Object.fromEntries(Object.entries(f.run).filter(([key]) => key !== 'executionSemanticsVersion'))
    const failed = WorkflowRunSchema.parse({ ...legacy, executionState: 'completed',
      outcome: 'failed', result: { outcome: 'failed', error: { code: 'SYNTHETIC_FAILURE', message: 'Task-owned test failure.', retryable: true } },
      finishedAt: new Date().toISOString() })
    await db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values($1,$2,$3,$4,'completed',$5::jsonb)`, [failed.id, failed.workspaceId, failed.workflowId, failed.workflowVersionId, JSON.stringify(failed)])
    const issued = await access.issue({ name: 'ENG-03 C legacy Operator', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }],
      expiresAt: new Date(Date.now() + 300_000) })
    vi.spyOn(locations, 'snapshot').mockResolvedValue(f.run.executionLocation!)
    const result = RunStartResultSchema.parse(await call(await connect(issued.token), 'run_retry', {
      workspaceId: f.scope.workspaceId, runId: failed.id, workflowVersionId: f.version.id,
      expectedLocationRevision: 1, commandId: randomUUID(),
    }))
    expect(result.accepted).toBe(true)
    expect('executionSemanticsVersion' in result.run).toBe(false)
    expect(result.run.input).toEqual(failed.input)
  })
})
