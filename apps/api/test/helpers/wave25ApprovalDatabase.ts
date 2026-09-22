import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { DurableInteractionSchema, HarnessExecutionSchema, ReviewJobSchema } from '@graphql/contracts'
import { WorkflowRunV2Schema, ExecutableWorkflowV2Schema, GraphDraftV2Schema } from '@graphql/contracts/wave25'
import { createDatabase } from '../../src/infrastructure/database.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { Wave25WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { wave25ApprovalMigrationSql } from '../../src/modules/interactions/wave25/migration.js'
import { Wave25ApprovalDraftService } from '../../src/modules/workflows/approvalDraftService.js'
import { approvalFixture, deliveryFixture } from './wave25ApprovalFixture.js'

/** Real isolated PostgreSQL. No provider starts, process credentials or bypasses.
 * Deliberately fails without TEST_DATABASE_URL: these are not mock DB tests. */
export async function approvalDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) throw new Error('Set TEST_DATABASE_URL for the Wave 2.5 approval integration suite.')
  const schema = `a4_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`)
  const database = createDatabase({ connectionString: url.toString(), maxConnections: 12, connectionTimeoutMs: 5000, queryTimeoutMs: 5000 })
  const close = async () => { await database.close(); try { await admin.query(`drop schema "${schema}" cascade`) } finally { await admin.end() } }
  try {
    await database.migrate()
    const pool = database.pool
    // In the S1 fixture this SQL is not registered yet. On an integrated checkout
    // apply it only when the terminal's registered migration did not already run.
    const added = await pool.query(`select 1 from information_schema.columns where table_schema=$1
      and table_name='review_jobs' and column_name='approval_native_evidence'`, [schema])
    if (!added.rowCount) await pool.query(wave25ApprovalMigrationSql)
    const f = approvalFixture()
    const { version } = ExecutableWorkflowV2Schema.parse({ version: f.version, configurations: f.configurations })
    const run = WorkflowRunV2Schema.parse(f.run)
    const [host, worker] = f.executions
    const reviewer = HarnessExecutionSchema.parse({ ...host, state: 'completed', result: { outcome: 'succeeded' },
      finishedAt: f.createdAt, workingDirectory: '/synthetic/approval-test' })
    const requester = HarnessExecutionSchema.parse({ ...worker, workingDirectory: '/synthetic/approval-test' })
    const raw = deliveryFixture().interaction
    const interaction = DurableInteractionSchema.parse({ ...raw, revision: 0, status: 'pending', deliveryState: 'not_started',
      selectedOptionId: undefined, selectedSemantic: undefined, nativeResponse: undefined, decidedAt: undefined })
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [run.workspaceId, JSON.stringify({ id: run.workspaceId, name: 'Approval tests' })])
    for (const c of f.configurations) {
      await pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)', [c.agentId, c.workspaceId, JSON.stringify({ id: c.agentId, name: c.agentId, productRole: c.productRole })])
      await pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)', [c.id, c.workspaceId, c.agentId, JSON.stringify(c)])
      await pool.query('update agents set current_configuration_version_id=$2 where id=$1', [c.agentId, c.id])
    }
    await pool.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)', [run.workflowId, run.workspaceId, JSON.stringify(version.definition)])
    await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
      values($1,$2,$3,1,$4,2,$5::jsonb)`, [version.id, version.workspaceId, version.workflowId, version.entryNodeId, JSON.stringify(version)])
    await pool.query('update workflows set current_version_id=$2 where id=$1', [run.workflowId, version.id])
    await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`, [run.id, run.workspaceId, run.workflowId, version.id, run.executionState, JSON.stringify(run)])
    await pool.query("insert into run_graph_heads(run_id,protocol_version,history_coverage) values($1,1,'from_admission')", [run.id])
    for (const e of [reviewer, requester]) {
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record)
        values($1,$2,$3,$4,1,$5,$6::jsonb)`, [e.id, e.runId, e.workflowNodeId, e.agentId, e.id === reviewer.id, JSON.stringify(e)])
      await pool.query(`insert into approval_execution_state(execution_id,graph_thread_id,active_timeout_ms,active_elapsed_ms)
        values($1,$2,600000,0)`, [e.id, interaction.graphThreadId])
      await pool.query(`insert into execution_native_sessions(execution_id,reference,workflow_finalized_at) values($1,$2::jsonb,$3)`,
        [e.id, JSON.stringify({ harness: 'codex', providerVersion: interaction.providerVersion, nativeSessionId: e.nativeSessionId }), e.id === reviewer.id ? f.createdAt : null])
    }
    const repository = new Wave25InteractionRepository(pool), access = new PostgresAccessService(pool)
    const commands = new PostgresCommandCoordinator(pool), credentials = new Wave25WorkerCredentialService(pool, access)
    for (const e of [reviewer, requester]) await repository.coordination.ensureLane({ id: `lane-${e.id}`, harness: 'codex',
      nativeSessionId: e.nativeSessionId!, ownerAgentId: e.agentId, revision: 0, observedStatus: 'idle', connectionGeneration: 0, observedAt: f.createdAt })
    const created = await repository.create(interaction)
    const job = (await repository.coordination.ensureReviewJob(ReviewJobSchema.parse({ id: 'review-approval', interactionId: interaction.id,
      reviewerAgentId: reviewer.agentId, attempt: 0, state: 'pending', provider: 'codex', nativeSessionId: reviewer.nativeSessionId,
      correlationId: 'correlation-review', createdAt: f.createdAt, updatedAt: f.createdAt }),
    { executionId: reviewer.id, workingDirectory: reviewer.workingDirectory!, providerVersion: interaction.providerVersion })).job
    const expiry = new Date(Date.now() + 60000).toISOString()
    const owned = await repository.coordination.claimReviewJob(job.id, 'test-review-worker', 'review-owner-token', expiry)
    const lane = (await repository.coordination.getLane('codex', reviewer.nativeSessionId!))!
    await repository.coordination.claimLane(lane.id, lane.revision, reviewer.agentId, 'native-writer-token', expiry, job.correlationId)
    await repository.coordination.bindLaneTurn({ id: lane.id, token: 'native-writer-token' }, job.correlationId)
    const submitted = await repository.coordination.transitionReviewJob(job.id, owned.leaseToken!, 'submitted', { writerFence: { id: lane.id, token: 'native-writer-token' } })
    const credential = await credentials.issueForReviewer(reviewer.id)
    const principal = await access.authenticate(credential.environment.variables.GRAPHQL_APP_MCP_TOKEN, 'worker')
    const operator = await access.issue({ name: 'approval-author', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['graph:read','graph:edit','workflows:read','agents:read'], scope: { workspaceIds: [run.workspaceId], workflowIds: [run.workflowId] } }] })
    const draft = GraphDraftV2Schema.parse({ id: 'draft-approval', workspaceId: run.workspaceId, workflowId: run.workflowId,
      revision: 0, baseWorkflowVersionId: version.id, publishedRevision: 0, graph: version.definition,
      stagedAgents: [], updatedByPrincipalId: operator.principal.id, updatedAt: f.createdAt })
    await pool.query(`insert into graph_drafts(id,workspace_id,workflow_id,revision,base_workflow_version_id,record)
      values($1,$2,$3,0,$4,$5::jsonb)`, [draft.id, run.workspaceId, run.workflowId, version.id, JSON.stringify(draft)])
    return { database, pool, close, repository, access, commands, credentials, credential, principal, operator,
      draft, draftService: new Wave25ApprovalDraftService(pool, commands), interaction: created.interaction, reviewer, requester, job: submitted,
      version, run, scope: { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, workflowVersionId: version.id, executionSemanticsVersion: 2 as const } }
  } catch (error) { await close(); throw error }
}
