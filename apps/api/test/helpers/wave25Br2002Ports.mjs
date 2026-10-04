/* global process, structuredClone */
/** BR2-002 LIMITED source harness. SQL, schema parsing, authority/context,
 * attention queries, and the superclass cleanup port are deliberately simulated.
 * The three owning source modules and COMPLETE reference reducer execute without
 * rewriting their bodies. This is NOT PostgreSQL, Zod, coordinator or provider
 * qualification. Run the companion integration suite for those real DB ports.
 * `actualProjection: true` additionally executes the real request creator,
 * attention/aggregate mapper, native selector and complete node projection.
 * In that mode only SQL rows, schemas, authority and transaction ports are fake;
 * node.activity and node.attention are NOT fabricated by this helper. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SourceTextModule, SyntheticModule } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.env.BR2_SOURCE_ROOT ?? resolve(here, '../../../..')
const sourceDir = resolve(root, 'apps/api/src/modules/interactions/wave25')
const referencePath = process.env.BR2_REFERENCE_PATH ?? resolve(root, 'packages/contracts/src/wave25/consumerFixture.ts')
const clone = structuredClone
const schema = { parse: clone, safeParse: (value) => ({ success: true, data: clone(value) }) }
const digest = (value) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = (e) => `${e.sourceKind}/${e.sourceId}/${e.sourceRevision}`
const fail = (code) => { throw Object.assign(new Error(code), { code }) }
const response = (rows = []) => ({ rows, rowCount: rows.length })
export const scope = { runId: 'run-br2002', workspaceId: 'workspace-br2002', workflowId: 'workflow-br2002', workflowVersionId: 'version-br2002', executionSemanticsVersion: 2 }
const identity = (e) => ({ workflowNodeId: e.workflowNodeId, executionId: e.id, agentId: e.agentId, agentConfigurationVersionId: e.agentConfigurationVersionId, attempt: e.attempt })
export const requester = { id: 'execution-worker', workflowNodeId: 'node-worker', agentId: 'worker', agentConfigurationVersionId: 'config-worker', attempt: 1 }
const reviewer = { id: 'execution-reviewer', workflowNodeId: 'node-reviewer', agentId: 'reviewer', agentConfigurationVersionId: 'config-reviewer', attempt: 1 }
export function interaction(id = 'interaction-one') {
  return { id, runId: scope.runId, executionId: requester.id, nativeRequestId: `native-${id}`, revision: 1,
    approval: { handler: 'user' }, status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' }
}
export async function ports(options = {}) {
  const actualProjection = options.actualProjection === true
  const data = { native: [], records: new Map((options.records ?? [interaction()]).map((r) => [r.id, clone(r)])),
    jobs: new Map(), attempts: new Map(), resumes: new Map(), receipts: new Map(), batches: [], sequence: 0,
    cleanupAllowed: false, stopped: false, nativeClosed: false, credentialsRevoked: false, failBeforeCommit: false,
    executionCompleted: false, v2: true, deliveryFences: new Map(), legacyCalls: [], superclassCalls: 0, cleanupInteractionsLocked: false }
  const contextFor = (record) => ({ scope, requester, stopped: data.cleanupAllowed || data.stopped,
    ...(record.approval.handler === 'orchestrator' ? { reviewer, relationshipId: 'approval-edge' } : {}) })
  const reviewPending = (j) => j.state !== 'completed' && !(j.state === 'failed' && j.cleanup?.completedAt)
  const retirementId = (id) => 'canceled-interaction-' + createHash('sha256').update(id, 'utf8').digest('hex')
  const retired = (r) => {
    const marker = data.receipts.get(`cleanup/${retirementId(r.id)}/${r.revision}`)
    const original = data.receipts.get(`interaction/${r.id}/${r.revision}`)
    return !!marker && !!original && marker.sourceDigest === original.sourceDigest
  }
  const counts = (replacement) => {
    const records = [...data.records.values()].map((r) => r.id === replacement?.id ? replacement : r)
    return { pendingInteractionCount: records.filter((r) => r.status !== 'canceled' && (r.status !== 'delivered' || !data.resumes.get(r.id)?.ack)).length,
      unsettledReviewCount: [...data.jobs.values()].filter(reviewPending).length, cleanupPending: data.cleanupAllowed && !data.nativeClosed }
  }
  const runState = (replacement) => ({ executionState: data.stopped ? 'completed' : 'waiting', outcome: data.stopped ? 'canceled' : 'pending', stopRequested: data.stopped, ...counts(replacement) })
  const attention = (replacement) => ({ workflowNodeId: requester.workflowNodeId, telemetry: 'current', ...counts(replacement) })
  let projectionModule, attentionModule, countsModule
  const nodeIds = [requester.workflowNodeId, reviewer.workflowNodeId]
  const executionFor = (id) => id === requester.id ? requester : reviewer
  const runRecord = () => ({ executionState: data.stopped ? 'completed' : 'waiting', outcome: data.stopped ? 'canceled' : 'pending' })
  const projectedRun = async () => {
    const totals = countsModule.publicAttentionTotals(await countsModule.readPublicAttentionCounts(sql, scope.runId))
    return { ...runRecord(), stopRequested: data.stopped, ...totals, cleanupPending: totals.cleanupPending || data.cleanupAllowed }
  }
  // SQL-shaped rows only. All overlays, activity selection, lifecycle, telemetry
  // and delta calculation are evaluated by the unchanged production modules.
  function projectionQuery(q, values) {
    const [id, ids, excluded] = values
    if (q.startsWith('select e.workflow_node_id as node_id,count(*)::text,')) {
      const reviews = q.includes('join review_jobs j')
      const records = reviews ? [...data.jobs.values()].filter((j) => j.id !== excluded && reviewPending(j))
        : [...data.records.values()].filter((r) => r.runId === id && r.id !== excluded && r.status !== 'canceled'
          && (r.status !== 'delivered' || !data.resumes.get(r.id)?.ack))
      const groups = new Map()
      for (const record of records) {
        const nodeId = executionFor(record.executionId ?? reviewer.id).workflowNodeId
        if (ids && !ids.includes(nodeId)) continue
        if (!groups.has(nodeId)) groups.set(nodeId, [])
        groups.get(nodeId).push(record)
      }
      return response([...groups].map(([node_id, records]) => reviews
        ? { node_id, count: String(records.length), cleanup: records.some((j) => !j.cleanup?.completedAt
          && (j.cleanup?.nativeState === 'pending' || j.cleanup?.credentialState === 'pending')) }
        : { node_id, count: String(records.length), pending_id: records.filter((r) => r.status === 'pending').map((r) => r.id).sort()[0] ?? null,
          blocked: records.some((r) => ['decided', 'delivery_pending', 'delivery_failed', 'delivered'].includes(r.status)) }))
    }
    if (q.startsWith('select record,execution_state,')) return response([{ record: runRecord(), execution_state: runRecord().executionState,
      stopped: data.stopped, cleanup: data.cleanupAllowed }])
    if (q.startsWith('select stop_requested_at is not null')) return response([{ closed: data.stopped }])
    if (q.startsWith("select e.id,e.workflow_node_id,e.record->>'agentId' as agent_id")) return response([requester, reviewer]
      .filter((e) => ids.includes(e.workflowNodeId)).map((e) => ({ id: e.id, workflow_node_id: e.workflowNodeId, agent_id: e.agentId,
        configuration_id: e.agentConfigurationVersionId, attempt: 1,
        state: e.id === reviewer.id || data.executionCompleted ? 'completed' : 'waiting',
        outcome: e.id === reviewer.id ? 'succeeded' : data.executionCompleted ? 'canceled' : null })))
    if (q.startsWith('select a.execution_id,a.workflow_node_id,a.attempt')) return response(data.native
      .filter((n) => !ids || ids.includes(n.key.execution.workflowNodeId)).map((n) => ({
        execution_id: n.key.execution.executionId, workflow_node_id: n.key.execution.workflowNodeId,
        attempt: n.key.execution.attempt, work_kind: n.key.workKind, work_id: n.key.workId,
        agent_id: n.key.execution.agentId, configuration_id: n.key.execution.agentConfigurationVersionId,
        activity: clone(n.activity), last_native_sequence: n.lastNativeSequence, terminal_native_sequence: null,
        projection_revision: '1', work_closed: n.key.workKind === 'workflow' && data.executionCompleted })))
    if (q.startsWith('select j.id from review_jobs j join harness_executions')) return response([...data.jobs.values()]
      .filter((j) => ids.includes(j.id) && j.state !== 'completed' && !j.cleanup?.completedAt).map((j) => ({ id: j.id })))
    if (q.startsWith("select n.node->>'id' as id")) return response(nodeIds.map((id) => ({ id })))
    if (q.startsWith('select record from durable_interactions where harness=')) return response([...data.records.values()]
      .filter((r) => r.harness === values[0] && r.nativeSessionId === values[1] && r.nativeRequestId === values[2]).map((r) => ({ record: clone(r) })))
    if (q.startsWith('insert into durable_interactions ')) {
      assert.equal(data.records.has(id), false)
      data.records.set(id, JSON.parse(values[11])); return response([{}])
    }
    if (q.startsWith('update approval_execution_state ')) return response([{}])
    return undefined
  }
  const sql = { async query(text, values = []) {
    const q = text.replace(/\s+/g, ' ').trim()
    const [id] = values
    if (actualProjection) { const rows = projectionQuery(q, values); if (rows) return rows }
    if (q === "select id from durable_interactions where run_id=$1 and status='canceled' order by id for update") {
      data.cleanupInteractionsLocked = true
      return response([...data.records.values()].filter((r) => r.runId === id && r.status === 'canceled').map((r) => ({ id: r.id })))
    }
    if (q.startsWith('select i.record from durable_interactions')) {
      const includesCanceled = q.includes("i.status='canceled' and not (")
      return response([...data.records.values()].filter((r) => r.runId === id && (r.status === 'canceled' ? includesCanceled && !retired(r)
        : r.status !== 'delivered' || !data.resumes.get(r.id)?.ack)).sort((a,b) => a.id.localeCompare(b.id)).slice(0, values[1]).map((r) => ({ record: clone(r) })))
    }
    if (q.startsWith('select j.record,j.revision::text')) {
      return response([...data.jobs.values()].filter((j) => reviewPending(j)).map((j) => ({ record: clone(j), revision: String(j.revision), interaction_record: clone(data.records.get(j.interactionId)) })))
    }
    if (q === 'select record from review_jobs where interaction_id=$1') return response([...data.jobs.values()].filter((j) => j.interactionId === id).map((j) => ({ record: clone(j) })))
    if (q.startsWith('select 1 where exists(select 1 from interaction_delivery_attempts')) return response(data.attempts.has(id) || data.resumes.has(id) ? [{}] : [])
    if (q.startsWith('select 1 from harness_executions')) return response(data.executionCompleted ? [{}] : [])
    if (q.startsWith('select id from durable_interactions where execution_id=') || q.startsWith('select i.id from durable_interactions i where i.execution_id=')) {
      const withCanceled = q.includes("i.status='canceled'")
      return response([...data.records.values()].filter((r) => r.executionId === id && (r.status === 'pending' || withCanceled && r.status === 'canceled' && !retired(r))
        && (!values[1] || values[1].includes(r.nativeRequestId))).map((r) => ({ id: r.id })))
    }
    if (q.startsWith('select i.id from durable_interactions i left join')) {
      const withCanceled = q.includes('or not (')
      return response([...data.records.values()].filter((r) => r.runId === id && (r.status !== 'canceled' || withCanceled && !retired(r))
        && !(r.status === 'delivered' && (data.resumes.get(r.id)?.state === 'resumed' || data.resumes.get(r.id)?.ack))).map((r) => ({ id: r.id })))
    }
    if (q.startsWith("select i.id from durable_interactions i where i.run_id=$1 and i.status='canceled'")) {
      return response([...data.records.values()].filter((r) => r.runId === id && r.status === 'canceled' && !retired(r)).map((r) => ({ id: r.id })))
    }
    if (q.startsWith('update durable_interactions set status=')) {
      const before = data.records.get(id)
      if (before?.revision !== values[4]) return response()
      data.records.set(id, JSON.parse(values[3])); return response([{}])
    }
    if (q.startsWith('update interaction_delivery_attempts')) {
      const attempt = data.attempts.get(id)
      if (attempt) { if (attempt.state === 'submitted') attempt.state = 'uncertain'; attempt.leaseExpiresAt = null }
      return response(attempt ? [{}] : [])
    }
    if (q.startsWith('update interaction_graph_resumes')) {
      const resume = data.resumes.get(id)
      if (resume && resume.state !== 'resumed') { resume.state = 'canceled'; resume.revision += 1; resume.owner = null }
      return response(resume ? [{}] : [])
    }
    if (q.startsWith('update durable_interactions set delivery_fence=')) {
      data.deliveryFences.set(id, (data.deliveryFences.get(id) ?? 0) + 1); return response([{}])
    }
    if (q.startsWith("select 1 from durable_interactions where id=$1 and run_id=$2 and status='canceled'")) {
      const r = data.records.get(id)
      return response(r?.runId === values[1] && r.status === 'canceled' && r.revision === values[2] ? [{}] : [])
    }
    throw new Error(`Unmodeled SQL port: ${q}`)
  } }
  let publicationModule
  async function transact(_pool, _run, work) {
    const before = clone(data), staged = new Map(), events = []
    const source = async (input, mutate) => {
      const k = key(input.evidence), existing = staged.get(k) ?? data.receipts.get(k)
      const value = { sourceDigest: input.sourceDigest, semanticDigest: digest(input.facts) }
      if (existing) { assert.deepEqual(existing, value); return { replayed: true } }
      await mutate(sql); staged.set(k, value)
      for (const fact of input.facts) events.push({ eventId: `event-${data.sequence}-${events.length}`, evidence: clone(input.evidence), fact: clone(fact) })
      return { replayed: false }
    }
    try {
      const result = await work({ sql, scope, source, effect: async (input, _guard, mutate) => source(input, mutate) })
      if (data.failBeforeCommit) throw new Error('injected-before-commit')
      if (events.length) {
        const previousSequence = String(data.sequence++)
        data.batches.push({ protocolVersion: 1, scope, batchId: `batch-${data.sequence}`, previousSequence, sequence: String(data.sequence), events })
      }
      for (const [k,v] of staged) data.receipts.set(k,v)
      return result
    } catch (error) { for (const [k,v] of Object.entries(before)) data[k] = v; throw error }
  }
  class LegacyRepository {
    constructor() {}
    async cancelPendingForExecution(...args) { data.legacyCalls.push(['execution', ...args]) }
    async cancelPendingForRun(...args) { data.legacyCalls.push(['run', ...args]); return 7 }
  }
  class CleanupPort {
    async finishStoppedReviewsInPublication(pub, credentialsRequired) {
      data.superclassCalls += 1
      assert.equal(data.cleanupInteractionsLocked, true, 'interaction locks must precede review cleanup')
      if (!data.nativeClosed) fail('UNCONFIRMED_NATIVE_CLOSURE')
      if (!data.cleanupAllowed) fail('EXECUTION_NOT_STOPPED')
      if (credentialsRequired && !data.credentialsRevoked) fail('REVIEW_CREDENTIAL_CLEANUP_PENDING')
      for (const job of [...data.jobs.values()].filter(reviewPending)) {
        const next = { ...job, revision: job.revision + 1, state: 'failed', cleanup: { nativeState: 'closed', credentialState: credentialsRequired ? 'revoked' : 'not_required', completedAt: '2026-09-22T01:00:00.000Z' } }
        await pub.source({ evidence: { sourceKind: 'cleanup', sourceId: job.id, sourceRevision: String(next.revision) }, sourceDigest: digest(next),
          facts: [publicationModule.reviewFact(contextFor(data.records.get(job.interactionId)), next, String(next.revision)),
            ...(actualProjection ? await attentionModule.approvalAttentionFacts(sql, contextFor(data.records.get(job.interactionId)), { review: next }) : []),
            { type: 'exchange.retired', exchangeKind: 'review', exchangeId: job.id, finalRevision: String(next.revision) }] }, async () => data.jobs.set(job.id, next))
      }
      if (actualProjection) return
      await pub.source({ evidence: { sourceKind: 'cleanup', sourceId: 'test-final-cleanup-state', sourceRevision: '0' }, sourceDigest: digest(runState()),
        facts: [{ type: 'run.state', state: runState() }, { type: 'node.attention', attention: attention() }] }, async () => undefined)
    }
    async finishStoppedReviews(runId, required) { await transact(null, runId, (pub) => this.finishStoppedReviewsInPublication(pub, required)) }
  }
  const stubs = {
    '@foreman-code/contracts': { DurableInteractionSchema: schema, ReviewJobSchema: schema },
    '@foreman-code/contracts/wave25': { GraphInteractionSchema: schema, GraphReviewSchema: schema, RUN_GRAPH_LIMITS: { nodes: 1000, exchanges: 2000 }, WorkflowRunV2Schema: schema, GraphAttentionSchema: schema, GraphExecutionIdentitySchema: schema, NativeGraphActivityRecordSchema: schema, canonicalGraphJson: JSON.stringify },
    'context.js': { identity, fail, isV2: async () => data.v2, assertBudget: async () => undefined, readContext: async (_sql,r,requireOpen) => {
      if (requireOpen && (data.stopped || data.cleanupAllowed || data.executionCompleted)) fail('EXECUTION_STOPPED')
      return contextFor(r)
    }, runFor: async () => scope.runId,
      lockInteraction: async (_sql,id) => clone(data.records.get(id)), transact },
    'connection.js': { assertGraphTransaction: (connection) => assert.equal(connection, sql), beforeGraphCommit: () => fail('UNMODELED_COMMIT_HOOK') },
    'records.js': { readNodeResolutions: async () => [] },
    'principal.js': { lockPrincipal: () => fail('UNMODELED_PRINCIPAL') },
    'attention.js': { approvalAttentionFacts: async (_sql,_context, proposed) => [{ type: 'node.attention', attention: attention(proposed.interaction) }, { type: 'run.state', state: runState(proposed.interaction) }] },
    'cleanupAuthority.js': { runCleanupAllowed: async () => data.cleanupAllowed },
    'publicLifecycle.js': { publicReviewUnsettled: reviewPending },
    'nativeEvidence.js': { acknowledgementId: () => undefined, reviewEvidence: async () => undefined },
    'errors.js': { RunGraphError: class extends Error { constructor(code) { super(code); this.code = code } } },
    'postgres.js': { PostgresInteractionRepository: LegacyRepository },
    'reviews.js': { Wave25InteractionCoordinationRepository: CleanupPort },
    'delivery.js': { Wave25InteractionDeliveryRepository: class {} },
    'decisions.js': { createRequest: () => fail('UNMODELED_CREATE'), decide: () => fail('UNMODELED_DECIDE') },
    'protocol.js': { RunGraphEventsResponseSchema: schema, RunGraphSnapshotSchema: schema, sameGraphScope: (a,b) => JSON.stringify(a) === JSON.stringify(b) },
    'reliability.js': { assertGraphRunTransition() {}, assertGraphNodeTransition() {} },
  }
  const productionFiles = actualProjection ? new Map([
    ...['decisions', 'attention'].map((name) => [`${name}.js`, resolve(sourceDir, `${name}.ts`)]),
    ...['publicProjection', 'publicLifecycle', 'currentAttention', 'currentActivity', 'nativeActivitySelection']
      .map((name) => [`${name}.js`, resolve(sourceDir, '../../run-graph', `${name}.ts`)]),
  ]) : new Map()
  const modules = new Map()
  function synthetic(k, exports) {
    if (!modules.has(k)) modules.set(k, new SyntheticModule(Object.keys(exports), function () { for (const [n,v] of Object.entries(exports)) this.setExport(n,v) }))
    return modules.get(k)
  }
  async function load(file) {
    if (modules.has(file)) return modules.get(file)
    const m = new SourceTextModule(stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'transform' }), { identifier: file })
    modules.set(file,m)
    await m.link(async (specifier) => {
      if (specifier === 'node:crypto') return synthetic(specifier, { createHash })
      if (specifier.includes('../../run-graph/publication.js')) return synthetic('graph-publication', { graphSourceDigest: digest })
      if (specifier === './publication.js') return load(resolve(sourceDir, 'publication.ts'))
      const base = specifier.split('/').pop()
      if (productionFiles.has(base)) return load(productionFiles.get(base))
      const stub = stubs[specifier] ?? stubs[base]
      if (!stub) throw new Error(`Unmodeled module port: ${specifier}`)
      return synthetic(specifier, stub)
    })
    return m
  }
  const pub = await load(resolve(sourceDir, 'publication.ts')); await pub.evaluate(); publicationModule = pub.namespace
  const repoModule = await load(resolve(sourceDir, 'repository.ts')); await repoModule.evaluate()
  const readsModule = await load(resolve(sourceDir, 'currentExchanges.ts')); await readsModule.evaluate()
  const reference = await load(referencePath); await reference.evaluate()
  const repository = new repoModule.namespace.Wave25InteractionRepository(sql)
  if (actualProjection) {
    projectionModule = (await load(productionFiles.get('publicProjection.js'))).namespace
    attentionModule = (await load(productionFiles.get('attention.js'))).namespace
    countsModule = (await load(productionFiles.get('currentAttention.js'))).namespace
  }
  const snapshot = async () => ({ protocolVersion: 1, scope, asOfSequence: String(data.sequence), retentionFloor: '0', historyCoverage: 'from_admission',
    topology: { nodes: ['node-worker', 'node-reviewer'], edges: ['approval-edge'] }, state: { run: actualProjection ? await projectedRun() : runState(),
      nodes: actualProjection ? await projectionModule.readPublicNodeProjection(sql, scope, nodeIds) : [{ state: { workflowNodeId: 'node-worker', lifecycle: 'waiting', execution: identity(requester) }, activity: { workflowNodeId: 'node-worker', status: 'none' }, attention: attention() }],
      inputBindings: [], ...await readsModule.namespace.readCurrentGraphExchanges(sql, scope) } })
  const replay = async (initial) => {
    const page = { kind: 'page', scope, baseSequence: initial.asOfSequence, throughSequence: String(data.sequence), retentionFloor: '0', hasMore: false,
      batches: data.batches.filter((b) => BigInt(b.sequence) > BigInt(initial.asOfSequence)) }
    const applied = reference.namespace.applyRunGraphPageFixture(initial, page, 1, 1)
    assert.ok(['applied','duplicate'].includes(applied.kind), applied.kind)
    assert.deepEqual(applied.snapshot, await snapshot())
    return applied.snapshot
  }
  // Seed source receipts for the starting records, not retirement receipts.
  for (const r of data.records.values()) data.receipts.set(`interaction/${r.id}/${r.revision}`, { sourceDigest: digest(r), semanticDigest: 'seeded-initial-state' })
  const boundary = async (stopped) => {
    assert.equal(actualProjection, true)
    const before = await projectionModule.readPublicNodeProjection(sql, scope, nodeIds)
    // Simulated negative lifecycle port, not production Stop/cleanup qualification.
    await transact(sql, scope.runId, async (pub) => {
      data.stopped = stopped; data.cleanupAllowed = true
      const after = await projectionModule.readPublicNodeProjection(sql, scope, nodeIds)
      await pub.source({ evidence: { sourceKind: 'run', sourceId: 'test-negative-boundary', sourceRevision: '1' },
        sourceDigest: digest({ stopped }), facts: [{ type: 'run.state', state: await projectedRun() },
          ...projectionModule.publicNodeProjectionDelta(before, after)] }, async () => undefined)
    })
  }
  return { boundary, data, sql, repository, publication: pub.namespace, snapshot, replay, transact: (work) => transact(sql, scope.runId, work), contextFor, retired, runState, attention }
}
