import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { HarnessExecutionRequest, WorkflowDefinition } from '@graphql/contracts'
import pg from 'pg'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import type { HarnessAdapter } from '../src/modules/harnesses/port.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
const workspaceId = 'workspace-1'
const workflowId = 'workflow-content-pipeline'
let schema: string
let root: string
let admin: pg.Pool
let pool: pg.Pool
let checkpoints: ReturnType<typeof createCheckpointStore>
let workflows: PostgresWorkflowRepository
let runs: PostgresRunRepository
let workspaces: PostgresWorkspaceRepository
let definition: WorkflowDefinition
const engines: LangGraphWorkflowEngine[] = []

beforeEach(async () => {
  schema = `regression_${randomUUID().replaceAll('-', '')}`
  root = await mkdtemp(join(tmpdir(), 'graphql-engine-'))
  admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5_000 })
  await applyApplicationMigrations(pool)
  await ensureAcceptanceSeed(pool)
  checkpoints = createCheckpointStore(connectionString, `${schema}_checkpoints`)
  await checkpoints.setup()
  workflows = new PostgresWorkflowRepository(pool)
  runs = new PostgresRunRepository(pool, workflows)
  workspaces = new PostgresWorkspaceRepository(pool, workflows, runs)
  const saved = await workflows.get(workspaceId, workflowId)
  if (!saved) throw new Error('Missing seeded workflow')
  definition = saved
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
})

function engine(onExecute: (request: HarnessExecutionRequest) => Promise<void> = async () => undefined) {
  const adapter: HarnessAdapter = {
    harness: 'codex',
    qualify: async () => { throw new Error('The deterministic integration adapter needs no external qualification') },
    resume: async () => { throw new Error('Interrupted side effects must not be replayed') },
    cancel: async () => false,
    execute: async (request, callbacks) => {
      callbacks.signal.throwIfAborted()
      await callbacks.onSession(`session-${request.executionId}`)
      await onExecute(request)
      callbacks.signal.throwIfAborted()
      return { outcome: 'succeeded', output: { text: request.workflowNodeId } }
    },
  }
  const instance = new LangGraphWorkflowEngine(runs, workflows, { resolve: () => adapter }, checkpoints.saver, root, 10_000)
  engines.push(instance)
  return instance
}

it('recovers work persisted as queued before a previous API could dispatch it', async () => {
  const run = await runs.createForWorkflow(workspaceId, workflowId, { marker: 'persisted' })
  const requests: HarnessExecutionRequest[] = []
  const restarted = engine(async (request) => { requests.push(request) })
  await restarted.reconcile()
  await expect.poll(async () => (await runs.get(run.id))?.executionState).toBe('completed')
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
  expect(requests).toHaveLength(3)
  expect(requests[0]?.input).toEqual({ marker: 'persisted' })
})

it('does not steal live ownership; a disconnected owner becomes interrupted and cancelable', async () => {
  const run = await runs.createForWorkflow(workspaceId, workflowId, {})
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
    }).toBe('interrupted')
    const attempts = await runs.listExecutions(run.id)
    expect(attempts[0]?.result?.error?.code).toBe('EXECUTION_INTERRUPTED')
    expect(attempts[0]?.nativeSessionId).toBe('existing-native-session')
    expect(await restarted.cancel(run.id)).toBe(true)
    expect((await runs.get(run.id))?.outcome).toBe('canceled')
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
  await expect(runs.createForWorkflow(workspaceId, workflowId, {})).rejects.toMatchObject({ code: 'WORKFLOW_CONFIGURATION_STALE' })
  await workflows.save(workspaceId, definition)
  const run = await runs.createForWorkflow(workspaceId, workflowId, {})
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
    const run = await runs.createForWorkflow(workspaceId, workflowId, {})
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
  const run = await runs.createForWorkflow(workspaceId, workflowId, {})
  await worker.start(run.id)
  expect(completed).toEqual([a.id, b.id, c.id])
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
})
