import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ManagementGrant } from '@graphql/contracts/management'
import {
  makeWave25Fixture, WorkflowVersionV3Schema, AcceptedWorkflowRunV3Schema, AcceptedRepeatStartV1Schema,
  CANONICAL_RUN_GRAPH_ROUTES, type RepeatGraphScopeV3,
} from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { readCurrentGraphExchanges } from '../src/modules/interactions/wave25/currentExchanges.js'
import { createCompactSnapshotAssembler } from '../src/modules/run-graph/compactSnapshot.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { RepeatGraphReadService } from '../src/modules/run-graph/repeatReadService.js'
import { graphSourceDigest, openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { publishRepeatRunStateLocked } from '../src/modules/run-graph/repeatPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'

export type GraphTestDatabase = Awaited<ReturnType<typeof agent3Database>>
export const privateCanary = 'ENG04-PRIVATE-INPUT-MUST-NOT-REACH-GRAPH'

/** Real database/transport fixture, not an engine, native host or qualification
 * adapter. Start authority/dispatch are not exercised by this SQL producer test.
 * Uses the repository's existing opt-in disposable schema/migration harness.
 */
export async function graphFixture(db: GraphTestDatabase, options: { insert?: boolean; qualifiedReads?: boolean } = {}) {
  const f = makeWave25Fixture(randomUUID())
  await seedAgent3(db.pool, db.directory, f, { run: false })
  const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
  const version = WorkflowVersionV3Schema.parse({ ...f.version, id: `${f.version.id}-repeat`, version: 2,
    executionSemanticsVersion: 3, definition: { ...f.version.definition, version: 2, executionSemanticsVersion: 3,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 }, nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }], repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] },
    } })
  version.contentHash = graphSourceDigest({ definition: version.definition,
    configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })
  await db.pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
    values($1,$2,$3,2,$4,3,$5::jsonb)`, [version.id, version.workspaceId, version.workflowId, version.entryNodeId, JSON.stringify(version)])
  await db.pool.query('update workflows set current_version_id=$2,record=$3::jsonb where id=$1',
    [version.workflowId, version.id, JSON.stringify(version.definition)])
  const revision = Number((await db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [version.workflowId])).rows[0]!.revision)
  const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
  const grantScope = { workspaceIds: [version.workspaceId], workflowIds: [version.workflowId] }
  const credential = (grants: ManagementGrant[]) => access.issue({ name: 'ENG04 graph disposable-test Operator', audience: 'operator',
    expiresAt: new Date(Date.now() + 300000), grants })
  const writer = await credential([{ actions: ['capabilities:read'], scope: {} }, { actions: ['runs:read'], scope: grantScope }])
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, workflowVersionId: version.id, executionSemanticsVersion: 3,
    authorizationPrincipalId: writer.principal.id, input: { canary: privateCanary } })
  const request = { workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: revision,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
    expectedLocationRevision: run.executionLocation.locationRevision, input: run.input }
  const accepted = AcceptedRepeatStartV1Schema.parse({ run, snapshot: { request,
    authorizationPrincipalId: writer.principal.id, executable: { version, configurations: f.configurations },
    workflow: { id: version.workflowId, workspaceId: version.workspaceId, revision, currentVersionId: version.id,
      archived: false, definition: version.definition },
    workspace: { id: version.workspaceId, archived: false, location: run.executionLocation }, draft: null,
  } })
  if (options.insert !== false) await withExclusiveGraphConnection(db.pool,
    (connection) => connection.transaction((sql) => insertRepeatRun(sql, accepted, repeatStartPublication)))
  const scope: RepeatGraphScopeV3 = { workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: version.id, runId: run.id, executionSemanticsVersion: 3 }
  // Test-local opt-in to a REAL reader/producer. Production default remains false.
  const repeat = new RepeatGraphReadService(db.pool, { qualifiedReads: options.qualifiedReads === true })
  const graph = new RunGraphReadService(db.pool, createCompactSnapshotAssembler(readCurrentGraphExchanges), { qualifiedReads: true, repeat })
  // Unrelated services are not called. Authentication, commands/audit, graph
  // services, canonical publisher and database are actual production classes.
  const services = { commands, runGraph: graph } as unknown as OperatorServices
  const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
    checkpoints: { ping: async () => undefined } }, operator: { access, services } })
  await app.ready()
  const readRequest = { protocolVersion: 1, scope }
  return { f, version, run, accepted, scope, grantScope, writer, credential, access, commands, repeat, graph, app, readRequest }
}
export type GraphFixture = Awaited<ReturnType<typeof graphFixture>>
export async function ownedGraph<T>(db: GraphTestDatabase, t: GraphFixture, work: (owner: RunOwnership) => Promise<T>): Promise<T> {
  const owner = await RunOwnership.acquire(db.pool, t.run.id, () => undefined)
  if (!owner) throw new Error('Disposable fixture Run already has an owner')
  try { return await work(owner) } finally { await owner.release() }
}
export async function changeRunState(db: GraphTestDatabase, t: GraphFixture, state: 'running' | 'waiting') {
  return ownedGraph(db, t, (owner) => owner.oneShotConnection().transaction(async (sql) => {
    const publication = await openRunGraphPublication(sql, t.scope)
    await sql.query(`update runs set execution_state=$2,record=jsonb_set(record,'{executionState}',to_jsonb($2::text)) where id=$1`, [t.run.id, state])
    await publishRepeatRunStateLocked(publication, owner)
  }))
}
export async function graphPosition(db: GraphTestDatabase, t: GraphFixture) {
  return (await db.pool.query<{ head: string }>('select head_sequence::text as head from run_graph_heads where run_id=$1', [t.run.id])).rows[0]!.head
}
export function graphUrl(t: GraphFixture, kind: 'current' | 'snapshot' | 'events', after?: string) {
  const route = CANONICAL_RUN_GRAPH_ROUTES[kind].replace(':workspaceId', t.scope.workspaceId)
    .replace(':workflowId', t.scope.workflowId).replace(':runId', t.scope.runId)
  const query = new URLSearchParams({ workflowVersionId: t.scope.workflowVersionId, executionSemanticsVersion: '3',
    ...(after === undefined ? {} : { afterSequence: after }) })
  return `${route}?${query}`
}
export function graphHeaders(token?: string) {
  return { host: 'localhost', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}
interface RpcResult {
  tools?: { name: string }[]; isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[]
}
interface RpcEnvelope { result?: RpcResult; error?: unknown }
const origins = new WeakMap<FastifyInstance, Promise<string>>()
export async function graphRpc(app: FastifyInstance, token: string, method: string, params: Record<string, unknown> = {}) {
  let origin = origins.get(app)
  if (!origin) { origin = app.listen({ host: '127.0.0.1', port: 0 }); origins.set(app, origin) }
  const response = await fetch(new URL('/mcp/operator', await origin), { method: 'POST',
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const text = await response.text()
  const message: RpcEnvelope = JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n') : text)
  return { status: response.status, ...message }
}
export function graphRpcValue(result: RpcResult | undefined): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = result?.content?.find((item) => item.type === 'text')?.text
  return text === undefined ? undefined : JSON.parse(text)
}
