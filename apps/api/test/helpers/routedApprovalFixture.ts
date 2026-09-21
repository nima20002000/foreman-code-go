import { randomUUID } from 'node:crypto'
import {
  AgentSchema, AgentConfigurationVersionSchema, WorkflowVersionSchema, WorkflowRunSchema,
  DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES,
  type HarnessExecution, type NativeSessionReference, type AgentConfigurationVersion,
} from '@graphql/contracts'
import type pg from 'pg'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { acceptedRunApproval } from '../../src/modules/workflows/approval.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { PostgresInteractionRepository } from '../../src/modules/interactions/postgres.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { DeterministicNativeSessionManager } from '../../src/testing/deterministicNativeSession.js'

export type ApprovalTopologyFixture = 'direct' | 'transitive' | 'unconnected' | 'same_agent_other_node'

/**
 * Valid identities with explicitly seeded historical topology. This is a database/
 * authorization fixture, not evidence that the engine admits a disconnected graph.
 * Native I/O is deterministic. No actual provider or native permission is changed.
 */
export async function routedApprovalFixture(pool: pg.Pool, root: string, projectRoot: string, topology: ApprovalTopologyFixture) {
  const prefix = `authority-${randomUUID()}`
  const workspaceId = 'workspace-1', workflowId = 'workflow-content-pipeline'
  const configurationIds: Record<string, string> = {}
  const configs: AgentConfigurationVersion[] = []
  const roles = [
    ['reviewer', 'agent-reviewer', 'orchestrator'],
    ['worker', 'agent-developer', 'coder'],
    ['bridge', 'agent-researcher', undefined],
  ] as const
  for (const [label, sourceId, role] of roles) {
    const source = await pool.query<{ agent: unknown; configuration: unknown }>(
      `select a.record as agent,c.record as configuration from agents a
       join agent_configuration_versions c on c.id=a.current_configuration_version_id where a.id=$1`, [sourceId],
    )
    const base = source.rows[0]
    if (!base) throw new Error(`Acceptance seed is missing ${sourceId}`)
    const agentId = `${prefix}-${label}`, configurationId = `${agentId}-config-v1`
    const agent = AgentSchema.parse({ ...AgentSchema.parse(base.agent), id: agentId,
      ...(role ? { productRole: role } : {}) })
    const configuration = AgentConfigurationVersionSchema.parse({
      ...AgentConfigurationVersionSchema.parse(base.configuration), id: configurationId, agentId, version: 1,
      ...(role ? { productRole: role } : {}),
    })
    await pool.query('insert into agents(id,workspace_id,record) values ($1,$2,$3::jsonb)', [agentId, workspaceId, JSON.stringify(agent)])
    await pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values ($1,$2,$3,1,$4::jsonb)',
      [configurationId, workspaceId, agentId, JSON.stringify(configuration)])
    await pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agentId, configurationId])
    configurationIds[agentId] = configurationId
    configs.push(configuration)
  }
  const reviewerConfiguration = configs[0]!, workerConfiguration = configs[1]!, bridgeConfiguration = configs[2]!
  const reviewerId = reviewerConfiguration.agentId, workerId = workerConfiguration.agentId
  const baseRow = await pool.query<{ record: unknown }>(
    'select record from workflow_versions where workflow_id=$1 order by version desc limit 1', [workflowId],
  )
  const base = WorkflowVersionSchema.parse(baseRow.rows[0]?.record)
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: reviewerId }
  const nodes = [
    { id: 'review', agentId: reviewerId, name: 'Luna' },
    { id: 'bridge', agentId: bridgeConfiguration.agentId, name: 'Bridge' },
    { id: 'worker', agentId: workerId, name: 'Worker' },
    ...(topology === 'same_agent_other_node' ? [{ id: 'other-worker', agentId: workerId, name: 'Other occurrence' }] : []),
  ]
  const edges = [
    { id: 'review-bridge', source: 'review', target: 'bridge' },
    ...(topology === 'direct' ? [{ id: 'direct', source: 'review', target: 'worker' }] : []),
    ...(topology === 'transitive' || topology === 'same_agent_other_node' ? [{ id: 'transitive', source: 'bridge', target: 'worker' }] : []),
    ...(topology === 'same_agent_other_node' ? [{ id: 'other-direct', source: 'review', target: 'other-worker' }] : []),
  ]
  const version = WorkflowVersionSchema.parse({ ...base, id: `${prefix}-version`, version: base.version + 1,
    entryNodeId: 'review', agentConfigurationVersionIds: configurationIds, approval,
    definition: { ...base.definition, version: base.version + 1, nodes,
      edges: edges.map((edge) => ({ ...edge, route: { outcomes: ['succeeded'] } })), approval, requiredAgentCount: nodes.length,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: nodes.length } },
  })
  await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record)
    values ($1,$2,$3,$4,$5,$6::jsonb)`, [version.id, workspaceId, workflowId, version.version, version.entryNodeId, JSON.stringify(version)])
  const commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands, root)
  const workflows = new PostgresWorkflowRepository(pool)
  const runs = new PostgresRunRepository(pool, workflows, locations)
  const at = new Date().toISOString()
  const run = WorkflowRunSchema.parse({ id: `${prefix}-run`, workspaceId, workflowId, workflowVersionId: version.id,
    agentConfigurationVersionIds: configurationIds, approval: acceptedRunApproval(version),
    executionCondition: version.definition.executionCondition, executionState: 'waiting', outcome: 'pending', input: {}, createdAt: at,
  })
  await runs.create(run)
  const manager = new DeterministicNativeSessionManager(workerConfiguration.harness.harness)
  const requesterId = `${prefix}-worker-execution`
  const session = await manager.attachSession({ harness: manager.harness,
    providerVersion: manager.harness === 'codex' ? '0.154.0' : '1.18.31',
    nativeSessionId: `${prefix}-native-session` }, { request: {
    executionId: requesterId, runId: run.id, workspaceId, workflowNodeId: 'worker',
    workingDirectory: projectRoot, runtimeDirectory: root, configuration: workerConfiguration, input: {},
  } })
  const requester: HarnessExecution = { id: requesterId, runId: run.id, workflowNodeId: 'worker', agentId: workerId,
    agentConfigurationVersionId: workerConfiguration.id, attempt: 1, input: {}, state: 'waiting',
    nativeSessionId: session.nativeSessionId, workingDirectory: projectRoot, runtimeDirectory: root, createdAt: at }
  const reviewerSession: NativeSessionReference = { harness: reviewerConfiguration.harness.harness,
    providerVersion: reviewerConfiguration.harness.harness === 'codex' ? '0.154.0' : '1.18.31', nativeSessionId: `${prefix}-review-session` }
  const reviewer: HarnessExecution = { ...requester, id: `${prefix}-review-execution`, workflowNodeId: 'review', agentId: reviewerId,
    agentConfigurationVersionId: reviewerConfiguration.id, nativeSessionId: reviewerSession.nativeSessionId,
    state: 'completed', result: { outcome: 'succeeded' }, finishedAt: at }
  await runs.ensureExecution(reviewer)
  await runs.ensureExecution(requester)
  await pool.query('update harness_executions set accepted=true where id=any($1::text[])', [[reviewer.id, requester.id]])
  const interactions = new PostgresInteractionRepository(pool)
  const budgets = new PostgresApprovalBudgetRepository(pool)
  await budgets.ensure(reviewer.id, run.id, 10_000)
  await budgets.finish(reviewer.id, at)
  await budgets.ensure(requester.id, run.id, 10_000)
  await budgets.beginWait(requester.id)
  await interactions.coordination.bindWorkflowSession(reviewer.id, reviewerSession)
  await interactions.coordination.finalizeWorkflowSession(reviewer.id)
  for await (const event of manager.startTurn(session, { prompt: 'deterministic approval fixture', clientCorrelationId: prefix })) { void event; break }
  const native = await manager.pending(session)
  if (!native?.turn.nativeRequestId) throw new Error('Deterministic native request missing')
  const saved = await interactions.create(DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES[session.harness],
    id: `${prefix}-interaction`, workspaceId, workflowId, runId: run.id, executionId: requester.id, requestingAgentId: workerId,
    approval: run.approval, graphThreadId: run.id, graphInterruptId: `${prefix}-interrupt`, harness: session.harness, nativeSessionId: session.nativeSessionId, providerVersion: session.providerVersion,
    nativeRequestId: native.turn.nativeRequestId, nativeRequestType: native.nativeRequestType,
    request: native.request, responseOptions: native.responseOptions,
  }))
  const service = new InteractionService(interactions, budgets, {
    attachInteraction: async () => ({ manager, session }),
    attachOwnedSession: async (_context, ownedSession) => ({ manager, session: ownedSession }),
  }, async () => undefined)
  return { run, version, runs, locations, workflows, commands, reviewer, reviewerId, reviewerSession,
    requester, manager, interactions, budgets, service, interaction: saved.interaction }
}
