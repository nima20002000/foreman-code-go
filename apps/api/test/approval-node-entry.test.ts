import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AgentConfigurationVersion, DurableInteraction, ExecutionResult, HarnessExecution,
  WorkflowRun, WorkflowVersion,
} from '@graphql/contracts'
import { MemorySaver } from '@langchain/langgraph'
import { it } from 'vitest'

import type { HarnessExecutionCallbacks, HarnessResolver } from '../src/modules/harnesses/port.js'
import type { ApprovalExecutionCoordinator, ApprovalExecutionObservation } from '../src/modules/interactions/execution.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

const now = '2026-09-16T00:00:00.000Z'
const success: ExecutionResult = { outcome: 'succeeded', output: { done: true } }

async function fixture(approval = true) {
  const root = await mkdtemp(join(tmpdir(), 'graphql-approval-node-'))
  const configuration: AgentConfigurationVersion = {
    id: 'configuration-1', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
    prompt: {}, assignedSkills: [], contentHash: 'sha256:fixture', createdAt: now,
    harness: { harness: 'codex', model: 'fixture', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' },
  }
  let run: WorkflowRun = {
    id: 'run-1', workspaceId: 'workspace-1', workflowId: 'workflow-1', workflowVersionId: 'version-1',
    agentConfigurationVersionIds: { 'agent-1': configuration.id },
    ...(approval ? { approval: { handler: 'user' as const } } : {}),
    executionLocation: { runnerId: 'runner-1', rootPath: root, locationRevision: 1, identityHash: 'sha256:fixture' },
    executionCondition: { kind: 'manual' }, executionState: 'queued', outcome: 'pending', input: {}, createdAt: now,
  }
  const version: WorkflowVersion = {
    id: run.workflowVersionId, workspaceId: run.workspaceId, workflowId: run.workflowId, version: 1,
    entryNodeId: 'node-1', agentConfigurationVersionIds: run.agentConfigurationVersionIds,
    definition: { id: run.workflowId, workspaceId: run.workspaceId, name: 'Fixture', executionCondition: { kind: 'manual' },
      nodes: [{ id: 'node-1', agentId: configuration.agentId, name: 'Approval', join: { mode: 'all' } }],
      edges: [], executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 } },
    contentHash: 'sha256:fixture', createdAt: now,
  }
  const executions = new Map<string, HarnessExecution>()
  const records = new Map<string, DurableInteraction>()
  const resumeIds: string[] = []
  const owner = { assertOwned() {}, client: {}, async release() {} } as unknown as RunOwnership
  let pendingIds = ['a']
  let legacyStarts = 0
  const runs = {
    async acquireOwnership() { return owner },
    async get() { return run },
    async updateState(_id: string, update: Partial<WorkflowRun>) { run = { ...run, ...update } },
    async createExecution(execution: HarnessExecution) { executions.set(execution.id, execution) },
    async updateExecution(execution: HarnessExecution) {
      assert.ok(executions.has(execution.id))
      executions.set(execution.id, execution)
    },
    async acceptExecutionResult(execution: HarnessExecution) {
      assert.ok(executions.has(execution.id), 'an execution must exist before accepting its result')
      executions.set(execution.id, execution)
    },
    async getAcceptedResult(id: string) { return executions.get(id)?.result },
    async recordActivity() {},
  } as unknown as PostgresRunRepository
  const interactions = {
    async bindGraphInterrupt(id: string, graphInterruptId: string) {
      const current = records.get(id)
      assert.ok(current)
      if (current.graphInterruptId) assert.equal(graphInterruptId, current.graphInterruptId)
      const next = { ...current, graphInterruptId }
      records.set(id, next)
      return next
    },
  } as unknown as PostgresInteractionRepository
  const approvals = {
    async ensureObserve(input: Parameters<ApprovalExecutionCoordinator['ensureObserve']>[0]): Promise<ApprovalExecutionObservation> {
      const execution: HarnessExecution = { ...input.candidate, id: 'execution-durable', nativeSessionId: 'session-exact',
        state: pendingIds.length ? 'waiting' : 'completed',
        ...(pendingIds.length ? {} : { result: success, finishedAt: now }) }
      executions.set(execution.id, execution)
      if (!pendingIds.length) return { state: 'completed', execution, result: success }
      const pending = pendingIds.map((id): DurableInteraction => {
        const existing = records.get(id)
        if (existing) return existing
        const interaction: DurableInteraction = {
          id, revision: 0, workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
          executionId: execution.id, requestingAgentId: configuration.agentId,
          harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'session-exact', nativeRequestId: `request-${id}`,
          nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: run.id,
          request: { command: id }, approval: { handler: 'user' }, responseOptions: [{
            optionId: `option-${id}`, label: 'Approve once', semantic: 'approve_once', persistence: 'request',
            affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
          }], status: 'pending', deliveryState: 'not_started', createdAt: now, updatedAt: now,
        }
        records.set(id, interaction)
        return interaction
      })
      return { state: 'waiting', execution, interaction: pending[0]!, interactions: pending }
    },
    async assertResume(execution: HarnessExecution, value: unknown) {
      const id = (value as { interactionId: string }).interactionId
      const delivered = records.get(id)
      assert.equal(delivered?.deliveryState, 'delivered')
      assert.equal(delivered?.executionId, execution.id)
      resumeIds.push(id)
    },
    async cancelRun() {},
  } as unknown as ApprovalExecutionCoordinator
  const harnesses = { resolve() { return {
    async execute(request: { executionId: string }, callbacks: HarnessExecutionCallbacks) {
      legacyStarts += 1
      assert.ok(executions.has(request.executionId), 'legacy execution must be persisted before native work')
      await callbacks.beforeSpawn?.()
      await callbacks.onSession('session-legacy')
      return success
    },
  } } } as unknown as HarnessResolver
  const workflows = { async getVersion() { return version }, async getAgentConfiguration() { return configuration } } as unknown as PostgresWorkflowRepository
  const locations = { async revalidateSnapshot() {} } as unknown as WorkspaceLocationService
  const engine = new LangGraphWorkflowEngine(runs, workflows, harnesses, new MemorySaver(), root, 60_000, locations,
    undefined, approvals, interactions)
  return {
    engine, records, executions, resumeIds,
    getRun: () => run,
    legacyStarts: () => legacyStarts,
    pending(ids: string[]) { pendingIds = ids },
    deliver(id: string) {
      const current = records.get(id)
      assert.ok(current?.graphInterruptId)
      const delivered: DurableInteraction = { ...current, status: 'delivered', deliveryState: 'delivered' }
      records.set(id, delivered)
      return delivered
    },
    async close() { await engine.shutdown(); await rm(root, { recursive: true, force: true }) },
  }
}

it('consumes returned LangGraph resume values while later native approvals are already pending', async () => {
  const f = await fixture()
  try {
    await f.engine.start(f.getRun().id)
    assert.equal(f.getRun().executionState, 'waiting')
    f.pending(['b'])
    await f.engine.resumeInteraction(f.deliver('a'))
    assert.equal(f.getRun().executionState, 'waiting')
    assert.deepEqual(f.resumeIds, ['a'])
    f.pending(['c'])
    await f.engine.resumeInteraction(f.deliver('b'))
    assert.equal(f.getRun().executionState, 'waiting')
    assert.deepEqual(f.resumeIds, ['a', 'a', 'b'])
    f.pending([])
    await f.engine.resumeInteraction(f.deliver('c'))
    assert.equal(f.getRun().outcome, 'succeeded')
    assert.deepEqual([...f.executions.keys()], ['execution-durable'])
    assert.equal(f.legacyStarts(), 0)
  } finally { await f.close() }
})

it('binds every simultaneous approval and allows the second request to be delivered first', async () => {
  const f = await fixture()
  try {
    f.pending(['a', 'b'])
    await f.engine.start(f.getRun().id)
    assert.ok(f.records.get('a')?.graphInterruptId)
    assert.equal(f.records.get('a')?.graphInterruptId, f.records.get('b')?.graphInterruptId)
    f.pending(['a'])
    await f.engine.resumeInteraction(f.deliver('b'))
    assert.equal(f.getRun().executionState, 'waiting')
    assert.deepEqual(f.resumeIds, ['b'])
    f.pending([])
    await f.engine.resumeInteraction(f.deliver('a'))
    assert.equal(f.getRun().outcome, 'succeeded')
    assert.equal(f.legacyStarts(), 0)
  } finally { await f.close() }
})

it('persists legacy executions when approval infrastructure exists but the run has no approval configuration', async () => {
  const f = await fixture(false)
  try {
    await f.engine.start(f.getRun().id)
    assert.equal(f.getRun().outcome, 'succeeded')
    assert.equal(f.legacyStarts(), 1)
    assert.equal(f.executions.size, 1)
    assert.equal([...f.executions.values()][0]?.state, 'completed')
    assert.equal([...f.executions.values()][0]?.nativeSessionId, 'session-legacy')
    assert.equal(f.records.size, 0)
  } finally { await f.close() }
})
