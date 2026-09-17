import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { HarnessExecutionSchema, WorkflowRunSchema, type HarnessExecutionRequest, type WorkflowDefinition } from '@graphql/contracts'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import type { ApprovalExecutionCoordinator, ApprovalExecutionObservation } from '../src/modules/interactions/execution.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
const workspaceId = 'workspace-1'
const workflowId = 'workflow-content-pipeline'
let schema: string
let root: string
let projectRoot: string
let admin: pg.Pool
let pool: pg.Pool
let checkpoints: ReturnType<typeof createCheckpointStore>
let workflows: PostgresWorkflowRepository
let runs: PostgresRunRepository
let workspaces: PostgresWorkspaceRepository
let definition: WorkflowDefinition
let locations: WorkspaceLocationService
const engines: LangGraphWorkflowEngine[] = []

beforeEach(async () => {
  schema = `regression_${randomUUID().replaceAll('-', '')}`
  root = await mkdtemp(join(tmpdir(), 'graphql-engine-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'graphql-project-'))
  admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5_000 })
  await applyApplicationMigrations(pool)
  await ensureAcceptanceSeed(pool)
  checkpoints = createCheckpointStore(connectionString, `${schema}_checkpoints`)
  await checkpoints.setup()
  workflows = new PostgresWorkflowRepository(pool)
  locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), root)
  runs = new PostgresRunRepository(pool, workflows, locations)
  workspaces = new PostgresWorkspaceRepository(pool, workflows, runs)
  const saved = await workflows.get(workspaceId, workflowId)
  if (!saved) throw new Error('Missing seeded workflow')
  definition = saved
  const rootDetails = await stat(projectRoot)
  await pool.query(
    `update workspaces set execution_location = $2::jsonb, execution_location_identity = $3::jsonb,
       location_revision = 1 where id = $1`,
    [workspaceId, JSON.stringify({ runnerId: 'runner-local', rootPath: await realpath(projectRoot) }),
      JSON.stringify({ device: String(rootDetails.dev), inode: String(rootDetails.ino) })],
  )
}, 15_000)

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((engine) => engine.shutdown()))
  await checkpoints?.close()
  await pool?.end()
  if (admin) {
    await admin.query(`drop schema if exists "${schema}" cascade`)
    await admin.query(`drop schema if exists "${schema}_checkpoints" cascade`)
    await admin.end()
  }
  if (root) await rm(root, { recursive: true, force: true })
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true })
})

function engine(onExecute: (request: HarnessExecutionRequest) => Promise<void> = async () => undefined) {
  const nativeExecutions = {
    reviewers: { shutdown: async () => undefined },
    residentRunIds: () => [] as string[],
    reconcileReviews: async () => undefined,
    cancelRun: async () => undefined,
    finishRun: async () => undefined,
    assertResume: async () => undefined,
    async ensureObserve(input: Parameters<ApprovalExecutionCoordinator['ensureObserve']>[0]): Promise<ApprovalExecutionObservation> {
      input.signal.throwIfAborted()
      const ensured = await runs.ensureExecution(input.candidate, input.owner)
      const request = { ...input.request, executionId: ensured.execution.id }
      await onExecute(request)
      input.signal.throwIfAborted()
      const result = { outcome: 'succeeded' as const, output: { text: request.workflowNodeId } }
      const execution = HarnessExecutionSchema.parse({
        ...ensured.execution, state: 'completed', result, finishedAt: new Date().toISOString(),
      })
      await runs.updateExecution(execution, input.owner)
      return { state: 'completed', execution, result }
    },
  } as unknown as ApprovalExecutionCoordinator
  const instance = new LangGraphWorkflowEngine(runs, workflows, nativeExecutions, checkpoints.saver, root, locations)
  engines.push(instance)
  return instance
}

it('recovers work persisted as queued before a previous API could dispatch it', async () => {
  const run = await runs.createForWorkflow(workspaceId, workflowId, { marker: 'persisted' }, 1)
  const requests: HarnessExecutionRequest[] = []
  const restarted = engine(async (request) => { requests.push(request) })
  await restarted.reconcile()
  await expect.poll(async () => (await runs.get(run.id))?.executionState).toBe('completed')
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
  expect(requests).toHaveLength(3)
  expect(requests[0]?.input).toEqual({ marker: 'persisted' })
  expect(requests.every((request) => request.workingDirectory === projectRoot)).toBe(true)
  expect(new Set(requests.map((request) => request.runtimeDirectory)).size).toBe(3)
  expect(requests.every((request) => request.runtimeDirectory.startsWith(`${root}/`))).toBe(true)
  expect(requests.every((request) => request.runtimeDirectory !== request.workingDirectory)).toBe(true)
})

it('keeps one accepted project directory across later nodes after workspace settings change', async () => {
  const replacement = await mkdtemp(join(tmpdir(), 'graphql-project-replacement-'))
  try {
    const run = await runs.createForWorkflow(workspaceId, workflowId, {}, 1)
    const requests: HarnessExecutionRequest[] = []
    const worker = engine(async (request) => {
      requests.push(request)
      if (requests.length !== 1) return
      const replacementDetails = await stat(replacement)
      await pool.query(
        `update workspaces set execution_location = $2::jsonb, execution_location_identity = $3::jsonb,
           location_revision = 2 where id = $1`,
        [workspaceId, JSON.stringify({ runnerId: 'runner-local', rootPath: await realpath(replacement) }),
          JSON.stringify({ device: String(replacementDetails.dev), inode: String(replacementDetails.ino) })],
      )
    })

    await worker.start(run.id)

    expect(requests).toHaveLength(3)
    expect(requests.every((request) => request.workingDirectory === projectRoot)).toBe(true)
    expect((await runs.get(run.id))?.executionLocation).toMatchObject({ rootPath: projectRoot, locationRevision: 1 })
  } finally {
    await rm(replacement, { recursive: true, force: true })
  }
})

it('fails clearly when the accepted path is replaced before launch instead of retargeting', async () => {
  const run = await runs.createForWorkflow(workspaceId, workflowId, {}, 1)
  const original = `${projectRoot}-accepted`
  await rename(projectRoot, original)
  await mkdir(projectRoot)
  const execute = vi.fn(async () => undefined)
  try {
    await engine(execute).start(run.id)
    expect(execute).not.toHaveBeenCalled()
    expect(await runs.get(run.id)).toMatchObject({
      executionState: 'completed', outcome: 'failed',
      result: { error: { code: 'WORKSPACE_LOCATION_CHANGED' } },
    })
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rename(original, projectRoot)
  }
})

it('rechecks revoked Operator authority before a queued Run launches', async () => {
  const run = await runs.createForWorkflow(workspaceId, workflowId, {}, 1)
  await pool.query(
    `insert into management_principals (id, name, audience, token_hash, grants, expires_at, revoked_at)
     values ($1, 'Revoked run owner', 'operator', $2, $3::jsonb, now() + interval '1 hour', now())`,
    ['revoked-run-owner', `hash-${randomUUID()}`, JSON.stringify([{
      actions: ['runs:start', 'workspace_locations:read'], scope: { workspaceIds: [workspaceId] },
    }])],
  )
  const authorized = WorkflowRunSchema.parse({ ...run, authorizationPrincipalId: 'revoked-run-owner' })
  await pool.query('update runs set record = $2::jsonb where id = $1', [run.id, JSON.stringify(authorized)])
  const execute = vi.fn(async () => undefined)

  await engine(execute).start(run.id)

  expect(execute).not.toHaveBeenCalled()
  expect(await runs.get(run.id)).toMatchObject({
    executionState: 'completed', outcome: 'failed',
    result: { error: { code: 'RUN_AUTHORIZATION_REVOKED' } },
  })
})

it('does not steal live ownership; a durable Stop intent completes after the disconnected owner releases', async () => {
  const run = await runs.createForWorkflow(workspaceId, workflowId, {}, 1)
  const owner = await runs.acquireOwnership(run.id, () => undefined)
  if (!owner) throw new Error('Ownership acquisition failed')
  try {
    await runs.updateState(run.id, { executionState: 'running', outcome: 'pending' }, owner)
    const node = definition.nodes[0]!
    await runs.createExecution({
      id: 'interrupted-execution', runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: run.agentConfigurationVersionIds[node.agentId]!,
      attempt: 1, input: {}, state: 'running', nativeSessionId: 'existing-native-session',
      createdAt: new Date().toISOString(),
    }, owner)
    const restarted = engine(async () => { throw new Error('An active attempt must not be replayed') })
    await restarted.reconcile()
    expect((await runs.get(run.id))?.executionState).toBe('running')
    expect(await restarted.cancel(run.id)).toBe(false)
    // Terminating the database session reproduces loss of the previous API owner.
    const { rows } = await owner.client.query<{ pid: number }>('select pg_backend_pid() as pid')
    await admin.query('select pg_terminate_backend($1)', [rows[0]!.pid])
    await expect.poll(async () => {
      await restarted.reconcile()
      return (await runs.get(run.id))?.executionState
    }).toBe('completed')
    const attempts = await runs.listExecutions(run.id)
    expect(attempts[0]?.result?.outcome).toBe('canceled')
    expect(attempts[0]?.nativeSessionId).toBe('existing-native-session')
    expect(await restarted.cancel(run.id)).toBe(true)
    expect((await runs.get(run.id))?.outcome).toBe('canceled')
    await expect(stat(projectRoot)).resolves.toMatchObject({})
  } finally {
    await owner.release()
  }
})

it('persists edited agent settings immutably and launches the newly pinned configuration', async () => {
  const agent = await workspaces.getAgent(workspaceId, 'agent-researcher')
  if (!agent?.configurationVersionId) throw new Error('Missing seeded configuration')
  const original = await workflows.getAgentConfiguration(agent.configurationVersionId)
  const saved = await workspaces.saveAgent(workspaceId, agent.id, {
    ...agent, harness: 'opencode', model: 'opencode-go/test-model', effort: 'max', fastMode: undefined,
  })
  expect(saved.configurationVersionId).not.toBe(agent.configurationVersionId)
  expect(await workflows.getAgentConfiguration(agent.configurationVersionId)).toEqual(original)
  await expect(runs.createForWorkflow(workspaceId, workflowId, {}, 1)).rejects.toMatchObject({ code: 'WORKFLOW_CONFIGURATION_STALE' })
  await workflows.save(workspaceId, definition)
  const run = await runs.createForWorkflow(workspaceId, workflowId, {}, 1)
  expect(run.agentConfigurationVersionIds[agent.id]).toBe(saved.configurationVersionId)
  const requests: HarnessExecutionRequest[] = []
  await engine(async (request) => { requests.push(request) }).start(run.id)
  const actual = requests.find((request) => request.configuration.agentId === agent.id)
  expect(actual?.configuration.harness).toMatchObject({ harness: 'opencode', model: 'opencode-go/test-model', variant: 'max' })
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
})

it('rejects a colliding workflow ID from another workspace without changing any workflow version', async () => {
  const otherWorkspace = 'workspace-other'
  const otherAgent = 'agent-other'
  const configurationId = 'configuration-other'
  const source = await workflows.getAgentConfiguration('agent-researcher-config-v1')
  if (!source) throw new Error('Missing source configuration')
  await pool.query('insert into workspaces (id, record) values ($1, $2::jsonb)', [otherWorkspace, JSON.stringify({ id: otherWorkspace, name: 'Other' })])
  await pool.query('insert into agents (id, workspace_id, current_configuration_version_id, record) values ($1,$2,$3,$4::jsonb)', [
    otherAgent, otherWorkspace, configurationId, JSON.stringify({ id: otherAgent, name: 'Other', configurationVersionId: configurationId }),
  ])
  await pool.query('insert into agent_configuration_versions (id, workspace_id, agent_id, version, record) values ($1,$2,$3,1,$4::jsonb)', [
    configurationId, otherWorkspace, otherAgent, JSON.stringify({ ...source, id: configurationId, workspaceId: otherWorkspace, agentId: otherAgent }),
  ])
  const snapshot = async () => ({
    workflows: (await pool.query('select * from workflows order by id')).rows,
    versions: (await pool.query('select * from workflow_versions order by id')).rows,
  })
  const before = await snapshot()
  await expect(workflows.save(otherWorkspace, {
    ...definition, workspaceId: otherWorkspace,
    nodes: [{ id: 'other-node', agentId: otherAgent, name: 'Other' }], edges: [],
  })).rejects.toMatchObject({ code: 'WORKFLOW_WORKSPACE_MISMATCH' })
  expect(await snapshot()).toEqual(before)
})

it('keeps a three-execution safety limit until the operator explicitly raises it for a fourth step', async () => {
  const extra = { ...definition.nodes[0]!, id: 'extra-step' }
  const expanded = {
    ...definition, nodes: [...definition.nodes, extra],
    edges: [...definition.edges, { id: 'extra-edge', source: definition.nodes[2]!.id, target: extra.id }],
  }
  await expect(workflows.save(workspaceId, expanded)).rejects.toMatchObject({ code: 'WORKFLOW_EXECUTION_LIMIT' })
  const saved = await workflows.save(workspaceId, { ...expanded, executionPolicy: { maxParallelism: 3, maxNodeExecutions: 4 } })
  expect(saved.nodes).toHaveLength(4)
  expect(saved.executionPolicy?.maxNodeExecutions).toBe(4)
})

for (const maximum of [1, 2]) {
  it(`enforces maxParallelism=${maximum} in the real LangGraph engine`, async () => {
    const [a, b, c] = definition.nodes
    if (!a || !b || !c) throw new Error('Expected three seeded nodes')
    await workflows.save(workspaceId, {
      ...definition, executionPolicy: { maxParallelism: maximum, maxNodeExecutions: 3 },
      edges: [{ id: 'a-b', source: a.id, target: b.id }, { id: 'a-c', source: a.id, target: c.id }],
    })
    let active = 0
    let peak = 0
    const worker = engine(async () => {
      active += 1
      peak = Math.max(peak, active)
      try { await delay(50) } finally { active -= 1 }
    })
    const run = await runs.createForWorkflow(workspaceId, workflowId, {}, 1)
    await worker.start(run.id)
    expect((await runs.get(run.id))?.outcome).toBe('succeeded')
    expect(peak).toBe(maximum)
  })
}

it('persists editor-style fan-in as all-join and executes C once after both A and B', async () => {
  const [a, b, c] = definition.nodes
  if (!a || !b || !c) throw new Error('Expected three seeded nodes')
  const saved = await workflows.save(workspaceId, {
    ...definition, edges: [...definition.edges, { id: 'a-c', source: a.id, target: c.id }],
  })
  expect(saved.nodes.find((node) => node.id === c.id)?.join).toEqual({ mode: 'all' })
  const completed: string[] = []
  const worker = engine(async (request) => {
    if (request.workflowNodeId === c.id) expect(completed).toEqual([a.id, b.id])
    completed.push(request.workflowNodeId)
  })
  const run = await runs.createForWorkflow(workspaceId, workflowId, {}, 1)
  await worker.start(run.id)
  expect(completed).toEqual([a.id, b.id, c.id])
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
})
