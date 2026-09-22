import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@graphql/contracts'
import { ExecutableWorkflowV2Schema, makeWave25Fixture, WorkflowRunV2Schema } from '@graphql/contracts/wave25'
import { ApprovalPostgresSaver } from '../../src/infrastructure/approvalCheckpointSaver.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { continuationValidator } from '../../src/modules/runs/continuation.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { insertOneShotRun } from '../../src/modules/runs/oneShotAdmission.js'
import { registerApprovalCheckpointResume } from '../../src/modules/runs/approvalCheckpointRegistration.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import { CheckpointTestProvider } from './wave25Br1003Provider.js'
import { approvalFixture } from './wave25ApprovalFixture.js'

/** Production-class composition at the provider port. Actual migrations, Run
 * owner, repository, coordinator, delivery service, engine, saver and atomic
 * registration are retained. Only provider transport and filesystem identity
 * qualification are synthetic. This is not a buildProductionApp/HTTP test. */
export async function checkpointRuntimeFixture(branches: 1 | 2 = 1, pendingPerExecution: 1 | 2 = 1,
  options: { acknowledgeStarts?: boolean; disconnectAfterStart?: boolean } = {}) {
  const db = await agent3Database()
  const engines: LangGraphWorkflowEngine[] = []
  try {
    const f = makeWave25Fixture(randomUUID())
    // Real request construction must ask the deterministic provider for an
    // approval. Keep the pinned sandbox/read-only configuration unchanged.
    f.configurations = f.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
      ...configuration, harness: structuredClone(approvalFixture().configurations[1]!.harness),
    }))
    if (branches === 2) {
      const original = f.configurations[1]!, existingNode = f.version.definition.nodes[1]!
      const configuration = AgentConfigurationVersionSchema.parse({ ...original, id: `${original.id}-parallel`, agentId: `${original.agentId}-parallel` })
      const node = { ...existingNode, id: `${existingNode.id}-parallel`, agentId: configuration.agentId }
      f.configurations.push(configuration)
      f.version.definition.nodes.push(node)
      f.version.definition.edges.push({ id: `parallel-${randomUUID()}`, kind: 'execution', source: f.version.entryNodeId, target: node.id })
      f.version.agentConfigurationVersionIds[configuration.agentId] = configuration.id
      f.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 3 }
    }
    f.version = ExecutableWorkflowV2Schema.parse({ version: f.version, configurations: f.configurations }).version
    f.run = WorkflowRunV2Schema.parse({ ...f.run, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds })
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const access = new PostgresAccessService(db.pool)
    const accepted = await access.issue({ name: 'Checkpoint test Run authority', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [
        { actions: ['runs:start'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] } },
        { actions: ['workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } },
      ] })
    f.run = WorkflowRunV2Schema.parse({ ...f.run, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
      authorizationPrincipalId: accepted.principal.id })
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, f.run)))
    const user = await access.issue({ name: 'Checkpoint test approver', audience: 'user', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.run.id] } }] })
    const provider = new CheckpointTestProvider(new Set(f.version.definition.nodes.filter((node) => node.id !== f.version.entryNodeId).map((node) => node.id)),
      pendingPerExecution, options.acknowledgeStarts === true, options.disconnectAfterStart === true)
    const saver = new ApprovalPostgresSaver(db.pool, undefined, { schema: db.schema })
    await saver.setup()
    function compose(checkpointer: ApprovalPostgresSaver = saver) {
      const workflows = new PostgresWorkflowRepository(db.pool)
      const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool))
      // No native binaries or accepted runner filesystem are qualified here.
      // Keep SQL authorization real, including its accepted/root grant checks.
      vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
      const runs = new PostgresRunRepository(db.pool, workflows, locations)
      const repository = new Wave25InteractionRepository(db.pool), budgets = new PostgresApprovalBudgetRepository(db.pool)
      const managers = new ExecutionScopedNativeSessionManagerResolver(() => provider.connection())
      const native = new ApprovalExecutionCoordinator(runs, repository, budgets, managers, 600000,
        undefined, continuationValidator(db.pool, locations))
      const engine = new LangGraphWorkflowEngine(runs, workflows, native, checkpointer, db.directory,
        locations, undefined, repository, undefined, { workerParallelism: 2 })
      const service = new InteractionService(repository, budgets, native, (interaction) => engine.resumeInteraction(interaction))
      registerApprovalCheckpointResume(service, engine)
      engines.push(engine)
      return { engine, service, repository, runs, native, locations }
    }
    const runtime = compose()
    const config = { configurable: { thread_id: f.run.id } }
    async function pending() {
      return (await runtime.repository.list({ runId: f.run.id, limit: 100 })).sort((a, b) => a.id.localeCompare(b.id))
    }
    async function receipts() {
      return (await db.pool.query(`select entity_id,effect_digest,first_sequence::text from run_graph_effects
        where run_id=$1 and effect_kind='graph.resume' order by entity_id`, [f.run.id])).rows
    }
    async function writes() { return (await saver.getTuple(config))?.pendingWrites ?? [] }
    return { db, f, ...runtime, compose, saver, provider, config, pending, receipts, writes,
      principal: user.principal, authorizationPrincipalId: accepted.principal.id,
      async close() {
        // Shutdown runs before ending their pools; all timing gates in the test
        // must be released in finally blocks before entering fixture cleanup.
        try { for (const engine of engines.reverse()) await engine.shutdown() }
        finally { await db.close() }
      } }
  } catch (error) {
    try { for (const engine of engines.reverse()) await engine.shutdown() } finally { await db.close() }
    throw error
  }
}
