import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  makeWave25Fixture, CANONICAL_RUN_GRAPH_ROUTES,
} from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { readCurrentGraphExchanges } from '../src/modules/interactions/wave25/currentExchanges.js'
import { createCompactSnapshotAssembler } from '../src/modules/run-graph/compactSnapshot.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { RepeatGraphReadService } from '../src/modules/run-graph/repeatReadService.js'
import { openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { publishRepeatRunStateLocked } from '../src/modules/run-graph/repeatPublication.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { createRepeatFixtureWriter, insertFixtureRepeatRun, repeatReadyAgent3Fixture } from './eng04-repeat-fixture-writer.js'

export type GraphTestDatabase = Awaited<ReturnType<typeof agent3Database>>
export const privateCanary = 'ENG04-PRIVATE-INPUT-MUST-NOT-REACH-GRAPH'

/** Real database/transport fixture, not an engine, native host or qualification
 * adapter. Start authority/dispatch are not exercised by this SQL producer test.
 * Uses the repository's existing opt-in disposable schema/migration harness.
 */
export async function graphFixture(db: GraphTestDatabase, options: { insert?: boolean; qualifiedReads?: boolean } = {}) {
  const f = repeatReadyAgent3Fixture(makeWave25Fixture(randomUUID()))
  await seedAgent3(db.pool, db.directory, f, { run: false })
  const fixtureWriter = await createRepeatFixtureWriter(db.pool, f)
  const saved = await fixtureWriter.publish(3)
  const { version, run, accepted, scope } = await insertFixtureRepeatRun(db.pool, f, saved,
    fixtureWriter.writer.principal.id, { insert: options.insert !== false, input: { canary: privateCanary } })
  const { access, commands, grantScope, credential, writer, repeats } = fixtureWriter
  // Test-local opt-in to a REAL reader/producer. Production default remains false.
  const repeat = new RepeatGraphReadService(db.pool, { qualifiedReads: options.qualifiedReads === true })
  const graph = new RunGraphReadService(db.pool, createCompactSnapshotAssembler(readCurrentGraphExchanges), { qualifiedReads: true, repeat })
  // Unrelated services are not called. Authentication, commands/audit, graph
  // services, canonical publisher and database are actual production classes.
  const services = { commands, repeats, runGraph: graph } as unknown as OperatorServices
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
