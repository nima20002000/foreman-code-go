import { decodeMcpToolResult, OperatorToolSchemaResultSchema } from '@foreman-code/contracts/operator-mcp'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { requestWorkflowStopLocked } from '../src/modules/runs/repeatLifecycle.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, RUN_INSPECTION_TOOLS, RUN_INSPECTION_LIMITS, CurrentWorkflowSaveResultSchema,
  RunRecordDetailSchema, WorkflowRunV3Schema,
  RunExecutionsPageSchema, RunExecutionDetailSchema, RunExecutionBindingsPageSchema, RunVersionDetailSchema,
  makeCurrentWorkflowFixture, type RunExecutionSummary, type RunInspectionToolName,
} from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { waitForSuccessfulRunCleanup } from './helpers/runSettlement.testSupport.js'
import * as terminalResolution from '../src/modules/runs/repeatNode.js'

type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
type Client = Fixture['client']
function value(result: { isError?: boolean | undefined; structuredContent?: unknown }): unknown {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}
function mcpError(result: unknown): string {
  const parsed = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  expect(parsed.isError).toBe(true)
  const text = parsed.content?.find((item) => item.type === 'text')?.text
  expect(text).toBeDefined()
  return (JSON.parse(text!) as { error: { code: string } }).error.code
}
const requestScope = (f: Fixture) => ({ workspaceId: f.f.scope.workspaceId, runId: f.f.run.id })
function path(input: Record<string, unknown>, name: RunInspectionToolName) {
  const { workspaceId, runId, executionId, ...query } = input
  const base = `/api/management/workspaces/${encodeURIComponent(String(workspaceId))}/runs/${encodeURIComponent(String(runId))}`
  const suffix = name === RUN_INSPECTION_TOOLS.record ? '/record'
    : name === RUN_INSPECTION_TOOLS.version ? '/version' : name === RUN_INSPECTION_TOOLS.executions ? '/executions'
    : `/executions/${encodeURIComponent(String(executionId))}${name === RUN_INSPECTION_TOOLS.bindings ? '/bindings' : ''}`
  const parameters = new URLSearchParams(Object.entries(query).filter(([, val]) => val !== undefined).map(([key, val]) => [key, String(val)]))
  return `${base}${suffix}${parameters.size ? `?${parameters}` : ''}`
}
async function parity(f: Fixture, client: Client, token: string, name: RunInspectionToolName, input: Record<string, unknown>) {
  const http = await f.app.inject({ method: 'GET', url: path(input, name), headers: { authorization: `Bearer ${token}` } })
  expect(http.statusCode, http.body).toBe(200)
  expect(http.headers['cache-control']).toBe('private, no-store')
  expect(http.headers.vary).toContain('Authorization')
  const mcp = value(await client.callTool({ name, arguments: input }))
  expect(http.json()).toEqual(mcp)
  return mcp
}
async function denied(f: Fixture, client: Client, token: string, name: RunInspectionToolName,
  input: Record<string, unknown>, status: number, code: string) {
  const http = await f.app.inject({ method: 'GET', url: path(input, name), headers: { authorization: `Bearer ${token}` } })
  expect(http.statusCode, http.body).toBe(status)
  expect(http.json()).toMatchObject({ error: { code } })
  expect(mcpError(await client.callTool({ name, arguments: input }))).toBe(code)
}
async function reader(f: Fixture, grants?: ManagementPrincipal['grants']) {
  const issued = await f.access.issue({ name: 'ENG-05 read-only inspector', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: grants ?? [
      { actions: ['capabilities:read'], scope: {} },
      { actions: ['runs:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId], runIds: [f.f.run.id] } },
      { actions: ['workflows:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId] } },
    ] })
  return { ...issued, client: await f.connect(issued.token) }
}
async function terminal(f: Fixture, runId = f.f.run.id, timeoutMs = 20000) {
  try {
    await waitForSuccessfulRunCleanup({ pool: f.db.pool, runId, timeoutMs,
      readRecord: () => f.services.runs.inspection.record(f.writer.principal,
        { workspaceId: f.f.scope.workspaceId, runId }) })
  } catch (error) {
    // A failed async Start can otherwise leave only "running" in the public
    // record. Keep failure evidence bounded and omit native/private payloads.
    const [executions, effects, activity] = await Promise.all([
      f.db.pool.query<{ workflow_node_id: string; accepted: boolean; state: string | null }>(
        `select workflow_node_id,accepted,record->>'status' as state from harness_executions
         where run_id=$1 order by created_at,id limit 8`, [runId]),
      f.db.pool.query<{ effect_kind: string; count: string }>(
        `select effect_kind,count(*)::text from run_graph_effects where run_id=$1
         group by effect_kind order by effect_kind`, [runId]),
      f.db.pool.query<{ kind: string }>(
        `select kind from run_activity where run_id=$1 order by sequence desc limit 12`, [runId]),
    ])
    throw new Error(`${String(error)}; progress=${JSON.stringify({
      dispatchErrors: f.dispatchErrors.map(String), providerCounts: f.provider.counts,
      startedNodes: f.provider.startedNodes, executions: executions.rows,
      effects: effects.rows, recentActivity: activity.rows.map((row) => row.kind),
    })}`, { cause: error })
  }
}
async function allExecutions(f: Fixture, r: Awaited<ReturnType<typeof reader>>) {
  const items: RunExecutionSummary[] = [], seen = new Set<string>()
  let cursor: string | undefined
  // The test is finite even if an incorrect server returns a cyclic cursor.
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const input = { ...requestScope(f), limit: 1, ...(cursor ? { cursor } : {}) }
    const page = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, input))
    expect(page.items).toHaveLength(1)
    expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, input)).toEqual(page)
    items.push(...page.items)
    if (!page.pageInfo.nextCursor) return items
    expect(seen.has(page.pageInfo.nextCursor)).toBe(false)
    seen.add(page.pageInfo.nextCursor); cursor = page.pageInfo.nextCursor
  }
  throw new Error('Inspection pagination did not terminate')
}
async function resaveChangingRepeat(f: Fixture) {
  const before = RunVersionDetailSchema.parse(await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.version, requestScope(f)))
  const graph = structuredClone(before.version.definition)
  if (graph.repeat) {
    delete graph.repeat
    graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: graph.nodes.length }
  } else {
    const exit = graph.nodes.at(-1)!
    exit.choice = { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
    ] }
    graph.repeat = { contractVersion: 1, blocks: [{ id: 'added-after-run', nodeIds: graph.nodes.map((node) => node.id),
      entryNodeId: before.version.entryNodeId, exitNodeId: exit.id, maxOccurrences: 2,
      repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
    graph.executionPolicy = { maxParallelism: 2, maxNodeExecutions: graph.nodes.length * 2 }
  }
  const row = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [before.scope.workflowId])).rows[0]!
  // Public location_set may have advanced the workspace since this Run was
  // accepted. Save against the live workspace revision; leave the old Run pin alone.
  const location = (await f.db.pool.query<{ revision: string }>(
    'select location_revision::text as revision from workspaces where id=$1', [before.scope.workspaceId])).rows[0]!
  const saved = CurrentWorkflowSaveResultSchema.parse(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: {
    workspaceId: before.scope.workspaceId, workflowId: before.scope.workflowId, executionSemanticsVersion: 3,
    commandId: randomUUID(), expectedRevision: Number(row.revision), expectedWorkflowVersionId: before.version.id,
    expectedLocationRevision: Number(location.revision), expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds, graph,
  } })))
  expect(saved.value.version.id).not.toBe(before.version.id)
  expect(!!saved.value.version.definition.repeat).toBe(!before.version.definition.repeat)
  expect(await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.version, requestScope(f))).toEqual(before)
}

afterEach(() => vi.restoreAllMocks())
// Real application migrations, current Save/Run publication, engine/repository/receipts,
// live SQL grants, HTTP security and authenticated MCP. Only the documented provider
// transport and runner filesystem qualification in checkpointRuntimeFixture are synthetic.
// No paid model/native binary is used. The shared integration fixture uses an isolated PostgreSQL schema.
describe.skipIf(!postgresEnabled)('ENG-05 PostgreSQL authenticated Run inspection parity', () => {
  it('reads an older accepted execution without recomputing its saved routing resolution', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id)
      await terminal(f)
      const r = await reader(f)
      const [execution] = await allExecutions(f, r)
      const args = { ...requestScope(f), executionId: execution!.executionId }
      const before = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, args))
      expect(before.acceptedResult.status).toBe('accepted')
      // Model a terminal algorithm change after immutable results were published.
      const calculate = terminalResolution.repeatTerminalResolution
      vi.spyOn(terminalResolution, 'repeatTerminalResolution').mockImplementation((...input) => {
        const resolution = calculate(...input)
        return { ...resolution, value: { ...resolution.value,
          resolvedAt: new Date(Date.parse(resolution.value.resolvedAt) + 1).toISOString() } }
      })
      const persisted = (await f.db.pool.query('select record from harness_executions where id=$1', [args.executionId])).rows[0]
      await expect(f.runs.getAcceptedResult(args.executionId)).rejects.toMatchObject({ code: 'REPEAT_INPUT_NOT_ACCEPTED' })
      await resaveChangingRepeat(f)
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, args)).toEqual(before)
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, args)).toEqual(before)
      const forbidden = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }])
      await denied(f, forbidden.client, forbidden.token, RUN_INSPECTION_TOOLS.execution, args, 403, 'ACCESS_DENIED')
      expect((await f.db.pool.query('select record from harness_executions where id=$1', [args.executionId])).rows[0])
        .toEqual(persisted)
    } finally {
      await f.close()
    }
  }, 90000)

  it('reads committed Run records during a held publication and preserves scoped access and persisted readback', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
    let release!: () => void
    const proceed = new Promise<void>(resolve => { release = resolve })
    let staged!: () => void
    const ready = new Promise<void>(resolve => { staged = resolve })
    const args = requestScope(f)
    const publication = withExclusiveGraphConnection(f.db.pool, connection => connection.transaction(async sql => {
      await requestWorkflowStopLocked(sql, args.runId, async transaction => {
        const live = await readLiveManagementPrincipal(transaction, f.writer.principal.id)
        requireAuthorization(live, 'runs:stop', { ...args, workflowId: f.f.scope.workflowId })
      })
      staged()
      await proceed
    })).then(() => ({ success: true as const }), error => ({ success: false as const, error }))
    let reading: Promise<void> | undefined
    try {
      await Promise.race([ready, publication.then(result => {
        if (!result.success) throw result.error
        throw new Error('Publication finished before its test barrier')
      })])
      const r = await reader(f)
      let result: [unknown, Awaited<ReturnType<typeof f.runs.getRepeatSnapshot>>] | undefined
      let readError: unknown
      reading = Promise.all([
        parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.record, args),
        f.runs.getRepeatSnapshot(args.runId),
      ]).then(value => { result = value }, error => { readError = error })
      await expect.poll(() => Boolean(result || readError), { timeout: 1500 }).toBe(true)
      if (readError) throw readError
      expect(RunRecordDetailSchema.parse(result![0])).toMatchObject({
        run: { executionState: 'queued', workflowVersionId: f.f.run.workflowVersionId },
        stopRequested: false, cleanupPending: false,
      })
      expect(result![1]).toMatchObject({ stopRequested: false, cleanupPending: false })
      const forbidden = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      await denied(f, forbidden.client, forbidden.token, RUN_INSPECTION_TOOLS.record, args, 403, 'ACCESS_DENIED')
      release()
      expect(await publication).toEqual({ success: true })
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.record, args))
        .toMatchObject({ stopRequested: true, cleanupPending: true })
      await f.access.revoke(r.principal.id)
      await expect(f.services.runs.inspection.record(r.principal, args)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally {
      release()
      await publication
      if (reading) await reading
      await f.close()
    }
  }, 90000)

  it('reads ordinary fork/join history, exact inputs/results, denied scopes and replayed pages; keeps its old pin after adding repeat', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'parallel'), approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id); await terminal(f)
      const r = await reader(f), args = requestScope(f)
      const discovery = (await r.client.listTools()).tools
      for (const name of Object.values(RUN_INSPECTION_TOOLS)) {
        const tool = discovery.find((item) => item.name === name)
        expect(tool?.name).toBe(name)
        expect(tool?.inputSchema.type).toBe('object')
        expect(tool).not.toHaveProperty('outputSchema')
        const schema = OperatorToolSchemaResultSchema.parse(value(await r.client.callTool({
          name: 'operator_tool_schema_get', arguments: { name, includeOutputSchema: true },
        })))
        expect(schema.name).toBe(name)
        expect(schema.inputSchema).toEqual(tool?.inputSchema)
        expect(schema.outputSchema?.type).toBe('object')
        expect(tool?.annotations?.readOnlyHint).toBe(true)
        expect(tool?.description).toBeTruthy()
      }
      expect(discovery.map((item) => item.name)).not.toContain('run_start')
      const capabilities = value(await r.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })) as {
        tools: string[]; requirements: Array<{ name: string; actions: string[] }> }
      expect(capabilities.tools).toEqual(expect.arrayContaining(Object.values(RUN_INSPECTION_TOOLS)))
      expect(capabilities.requirements.find((item) => item.name === RUN_INSPECTION_TOOLS.version)?.actions).toEqual(['runs:read', 'workflows:read'])
      const invalid = await f.app.inject({ method: 'GET', url: path(args, RUN_INSPECTION_TOOLS.executions), headers: { authorization: 'Bearer invalid' } })
      expect(invalid.statusCode).toBe(401)

      const counts = { ...f.provider.counts }
      const items = await allExecutions(f, r)
      expect(items).toHaveLength(4)
      for (const item of items) {
        expect(item).not.toHaveProperty('occurrence')
        expect(item).not.toHaveProperty('input'); expect(item).not.toHaveProperty('result')
        expect(item).not.toHaveProperty('nativeSession'); expect(item).not.toHaveProperty('workingDirectory')
      }
      const ids = (await f.db.pool.query<{ id: string }>(
        'select id from harness_executions where run_id=$1 order by created_at desc,id desc', [args.runId])).rows.map((row) => row.id)
      expect(items.map((item) => item.executionId)).toEqual(ids)
      expect((await f.db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [args.runId])).rows).toEqual([])
      const join = items.find((item) => item.workflowNodeId === f.f.version.definition.nodes.at(-1)!.id)!
      const detailArgs = { ...args, executionId: join.executionId }
      const detail = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, detailArgs))
      const stored = (await f.db.pool.query<{ input_json: string; input_digest: string; result_json: string; result_digest: string }>(
        `select s.input_json,s.input_digest,r.result_json,r.result_digest from run_repeat_executions x
         join run_repeat_slots s on s.slot_id=x.slot_id join run_repeat_results r on r.execution_id=x.execution_id
         where x.execution_id=$1 and x.run_id=$2`, [join.executionId, args.runId])).rows[0]!
      expect(detail.acceptedInput).toEqual({ digest: stored.input_digest, value: JSON.parse(stored.input_json) })
      expect(detail.acceptedResult).toEqual({ status: 'accepted', digest: stored.result_digest, value: JSON.parse(stored.result_json) })
      expect(detail.acceptedInput.value.predecessors).toHaveLength(2)
      expect(detail.acceptedInput.value.occurrence).toBeNull()
      const first = RunExecutionBindingsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, { ...detailArgs, limit: 1 }))
      expect(first.items).toHaveLength(1); expect(first.items[0]?.ordinal).toBe(0)
      expect(first.pageInfo.nextCursor).not.toBeNull()
      const secondArgs = { ...detailArgs, limit: 1, cursor: first.pageInfo.nextCursor! }
      const second = RunExecutionBindingsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, secondArgs))
      expect(second.items).toHaveLength(1); expect(second.items[0]?.ordinal).toBe(1)
      expect(second.pageInfo.nextCursor).toBeNull()
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, secondArgs)).toEqual(second)
      expect([...first.items, ...second.items].map((item) => item.source)).toEqual(detail.acceptedInput.value.predecessors)
      expect(f.provider.counts).toEqual(counts)
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings,
        { ...secondArgs, executionId: items.find((item) => item.executionId !== join.executionId)!.executionId }, 400, 'RUN_INSPECTION_CURSOR_INVALID')

      const firstExecutions = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, limit: 1 }))
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, limit: 1,
        workflowNodeId: join.workflowNodeId, cursor: firstExecutions.pageInfo.nextCursor! }, 400, 'RUN_INSPECTION_CURSOR_INVALID')
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, workflowNodeId: 'missing-node' }, 404, 'WORKFLOW_NODE_NOT_FOUND')
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, occurrenceId: 'missing-occurrence' }, 404, 'RUN_OCCURRENCE_NOT_FOUND')
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...detailArgs, workspaceId: 'wrong-workspace' }, 404, 'RUN_NOT_FOUND')
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...detailArgs, runId: 'wrong-run' }, 404, 'RUN_NOT_FOUND')
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...detailArgs, executionId: 'wrong-execution' }, 404, 'RUN_EXECUTION_NOT_FOUND')

      const d = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      for (const name of Object.values(RUN_INSPECTION_TOOLS)) {
        expect((await d.client.listTools()).tools.map((tool) => tool.name)).not.toContain(name)
        await denied(f, d.client, d.token, name,
          name === RUN_INSPECTION_TOOLS.execution || name === RUN_INSPECTION_TOOLS.bindings ? detailArgs : args, 403, 'ACCESS_DENIED')
      }
      const audit = (await f.db.pool.query<{ source: string }>('select source from management_audit where principal_id=$1', [d.principal.id])).rows
      expect(audit.map((row) => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
      const wrongGrant = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: ['other-workspace'] } }])
      await denied(f, wrongGrant.client, wrongGrant.token, RUN_INSPECTION_TOOLS.execution, detailArgs, 403, 'ACCESS_DENIED')
      const runsOnly = await reader(f, [{ actions: ['runs:read'], scope: { runIds: [args.runId] } }])
      await parity(f, runsOnly.client, runsOnly.token, RUN_INSPECTION_TOOLS.execution, detailArgs)
      const runRecord = RunRecordDetailSchema.parse(await parity(f, runsOnly.client, runsOnly.token, RUN_INSPECTION_TOOLS.record, args))
      expect(runRecord.run.workflowVersionId).toBe(f.f.version.id)
      expect(runRecord.run.agentConfigurationVersionIds).toEqual(f.f.version.agentConfigurationVersionIds)
      expect(runRecord.run).not.toHaveProperty('authorizationPrincipalId')
      expect(runRecord.run).not.toHaveProperty('executionLocation')
      expect(Object.keys(runRecord).sort()).toEqual(['cleanupPending', 'run', 'stopRequested'])
      await denied(f, runsOnly.client, runsOnly.token, RUN_INSPECTION_TOOLS.version, args, 403, 'ACCESS_DENIED')

      // Same actual workflow/node, different authentic Run/execution: no cross-Run detail leak.
      // The shared provider fixture seeds a synthetic runner/identity; a real MCP
      // Start revalidates the location, so save it through the real location tool.
      const location = value(await f.client.callTool({ name: 'workspace_location_set', arguments: {
        workspaceId: args.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
        runnerId: f.locations.runnerId, rootPath: f.db.directory } })) as { locationRevision?: number; value?: { locationRevision: number } }
      const locationRevision = location.value?.locationRevision ?? location.locationRevision
      expect(locationRevision).toBe(2)
      expect(f.f.run.executionLocation?.locationRevision).toBe(1)
      const revision = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.f.scope.workflowId])).rows[0]!.revision
      const started = value(await f.client.callTool({ name: 'run_start', arguments: {
        workspaceId: args.workspaceId, workflowId: f.f.scope.workflowId, workflowVersionId: f.f.version.id,
        executionSemanticsVersion: 3, expectedWorkflowRevision: Number(revision),
        expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds, expectedLocationRevision: locationRevision,
        commandId: randomUUID(), input: {},
      } })) as { run: { id: string } }
      await terminal(f, started.run.id, 60000)
      const otherExecution = (await f.db.pool.query<{ id: string }>('select id from harness_executions where run_id=$1 order by id limit 1', [started.run.id])).rows[0]!.id
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...args, executionId: otherExecution }, 404, 'RUN_EXECUTION_NOT_FOUND')
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, runId: started.run.id }, 403, 'ACCESS_DENIED')
      expect(new Set(f.provider.startedExecutions).size).toBe(f.provider.startedExecutions.length)
      const indexes = (await f.db.pool.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname=current_schema() and indexname like 'eng05_%'" )).rows
      expect(indexes).toHaveLength(5)
      const oldRecord = await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.record, args)
      await resaveChangingRepeat(f)
      expect(await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.record, args)).toEqual(oldRecord)
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 150000)

  it('retains two real occurrences, attempt identities, exact text-carrier result and carry ancestry after removing repeat', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'repeat'), exitId = fixture.version.definition.nodes[1]!.id
    let exits = 0
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], outputFor: (nodeId) => nodeId !== exitId ? { nodeId }
      : { text: JSON.stringify({ routing: { outcome: ++exits === 1 ? 'issues' : 'pass' },
        data: { latestDeliverable: { occurrence: exits }, remainingFindings: exits === 1 ? [{ id: 'finding-1' }] : [] } }) } })
    try {
      await f.engine.start(f.f.run.id); await terminal(f)
      const r = await reader(f), args = requestScope(f), items = await allExecutions(f, r)
      expect(exits).toBe(2); expect(items).toHaveLength(4)
      expect(new Set(items.map((item) => item.executionId)).size).toBe(4)
      expect(new Set(items.map((item) => item.occurrence?.occurrenceIndex))).toEqual(new Set([1, 2]))
      expect(items.every((item) => item.attempt === 1)).toBe(true)
      const entry = f.f.version.entryNodeId, secondEntry = items.find((item) => item.workflowNodeId === entry && item.occurrence?.occurrenceIndex === 2)!
      const local = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions,
        { ...args, workflowNodeId: entry, occurrenceId: secondEntry.occurrence!.occurrenceId }))
      expect(local.items.map((item) => item.executionId)).toEqual([secondEntry.executionId])
      const across = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, workflowNodeId: entry }))
      expect(across.items).toHaveLength(2)
      const detailArgs = { ...args, executionId: secondEntry.executionId }
      const detail = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, detailArgs))
      const bindings = RunExecutionBindingsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, { ...detailArgs, limit: 1 }))
      expect(bindings.items).toHaveLength(1); expect(bindings.pageInfo.nextCursor).toBeNull()
      const carry = bindings.items[0]!
      expect(carry.kind).toBe('carry')
      if (carry.kind !== 'carry') throw new Error('Expected the exact second-occurrence carry')
      expect(carry.recipientOccurrence?.occurrenceIndex).toBe(2)
      expect(carry.source.execution.occurrence.occurrenceIndex).toBe(1)
      expect(carry.source.execution.occurrence.blockId).toBe(carry.recipientOccurrence?.blockId)
      expect(carry.source).toEqual(detail.acceptedInput.value.entry?.carry)
      const source = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution,
        { ...args, executionId: carry.source.execution.executionId }))
      expect(source.acceptedResult.status).toBe('accepted')
      if (source.acceptedResult.status !== 'accepted') throw new Error('Missing accepted source')
      expect(source.acceptedResult.value).toEqual(carry.source.acceptedResult)
      expect(source.acceptedResult.digest).toBe(carry.source.acceptedResultDigest)
      expect(source.acceptedResult.value.output).toEqual({ text: expect.any(String) })
      const persisted = (await f.db.pool.query<{ result_json: string; result_digest: string }>(
        'select result_json,result_digest from run_repeat_results where run_id=$1 and execution_id=$2', [args.runId, carry.source.execution.executionId])).rows[0]!
      expect(source.acceptedResult.value).toEqual(JSON.parse(persisted.result_json))
      expect(source.acceptedResult.digest).toBe(persisted.result_digest)
      expect((await f.db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [args.runId])).rows).toHaveLength(2)
      const counts = { ...f.provider.counts }
      await resaveChangingRepeat(f)
      expect(f.provider.counts).toEqual(counts)
      const old = RunVersionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.version, args))
      expect(old.version.definition.repeat?.blocks).toHaveLength(1)
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, detailArgs)).toEqual(detail)
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it('reports a waiting execution as not accepted, never promotes an unaccepted native report to input', async () => {
    const f = await currentOperatorIntegration()
    try {
      await f.engine.start(f.f.run.id)
      await expect.poll(async () => (await f.runs.get(f.f.run.id))?.executionState, { timeout: 20000 }).toBe('waiting')
      const r = await reader(f), args = requestScope(f)
      const page = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, args))
      const waiting = page.items.find((item) => !item.acceptedResultAvailable)!
      expect(waiting).toBeDefined()
      const detail = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution,
        { ...args, executionId: waiting.executionId }))
      expect(detail.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(detail.execution.acceptedResultAvailable).toBe(false)
      expect(detail.acceptedInput.value.predecessors).toHaveLength(1)
      expect(detail).not.toHaveProperty('reportedResult')
      await f.stop()
    } finally { await f.close() }
  }, 90000)

  it('discloses the exact Run-only record over HTTP/MCP when aggregate execution history exceeds 2 MiB', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    // Four real executions each retain this input. No execution/receipt rows are
    // fabricated; each individual accepted input stays below the existing 4 MiB bound.
    fixture.run.input = { instruction: 'Retain the exact original Run input', payload: 'x'.repeat(768 * 1024) }
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
    try {
      const args = requestScope(f), name = RUN_INSPECTION_TOOLS.record
      const queued = RunRecordDetailSchema.parse(await parity(f, f.client, f.writer.token, name, args))
      expect(queued.run.executionState).toBe('queued')
      expect(queued.run).not.toHaveProperty('result')
      await f.engine.start(f.f.run.id); await terminal(f)
      const counts = { ...f.provider.counts }
      const aggregate = await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${args.workspaceId}/runs/${args.runId}`,
        headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(aggregate.statusCode, aggregate.body).toBe(409)
      expect(aggregate.json()).toMatchObject({ error: { code: 'RUN_DETAIL_TOO_LARGE' } })

      const persisted = (await f.db.pool.query<{ record: unknown; stopped: boolean; pending: boolean }>(
        `select r.record,r.stop_requested_at is not null as stopped,
         exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as pending
         from runs r where r.id=$1`, [args.runId])).rows[0]!
      const expected = WorkflowRunV3Schema.parse(persisted.record)
      delete expected.authorizationPrincipalId
      const full = RunRecordDetailSchema.parse(await parity(f, f.client, f.writer.token, name, args))
      expect(full).toEqual({ run: expected, stopRequested: persisted.stopped, cleanupPending: persisted.pending })
      expect(full.run.input).toEqual(fixture.run.input)
      expect(full.run.result).toBeDefined()
      expect(full.run.executionLocation).toEqual(queued.run.executionLocation)
      expect(full.run.agentConfigurationVersionIds).toEqual(queued.run.agentConfigurationVersionIds)
      expect(full.run.workflowVersionId).toBe(queued.run.workflowVersionId)
      expect(Object.keys(full).sort()).toEqual(['cleanupPending', 'run', 'stopRequested'])
      expect(Buffer.byteLength(JSON.stringify(full), 'utf8')).toBeLessThan(RUN_INSPECTION_LIMITS.responseBytes)
      expect(f.provider.counts).toEqual(counts)

      const restricted = await reader(f, [{ actions: ['runs:read'], scope: { runIds: [args.runId] } }])
      const redacted = RunRecordDetailSchema.parse(await parity(f, restricted.client, restricted.token, name, args))
      delete expected.executionLocation
      expect(redacted).toEqual({ run: expected, stopRequested: persisted.stopped, cleanupPending: persisted.pending })
      const forbidden = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      expect((await forbidden.client.listTools()).tools.map((tool) => tool.name)).not.toContain(name)
      await denied(f, forbidden.client, forbidden.token, name, args, 403, 'ACCESS_DENIED')
      const audits = (await f.db.pool.query<{ source: string }>(
        'select source from management_audit where principal_id=$1', [forbidden.principal.id])).rows
      expect(audits.map((row) => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
      const wrongScope = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: ['other-workspace'] } }])
      await denied(f, wrongScope.client, wrongScope.token, name, args, 403, 'ACCESS_DENIED')
      await denied(f, f.client, f.writer.token, name, { ...args, workspaceId: 'missing-workspace' }, 404, 'RUN_NOT_FOUND')
      expect((await f.app.inject({ method: 'GET', url: path(args, name), headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)

      // The database itself refuses to rewrite an admitted Run's version pin.
      await expect(f.db.pool.query("update runs set record=jsonb_set(record,'{workflowVersionId}',to_jsonb($2::text)) where id=$1",
        [args.runId, 'corrupt-version-pin'])).rejects.toThrow(/REPEAT_RUN_PIN_IMMUTABLE/)
      expect(await parity(f, f.client, f.writer.token, name, args)).toEqual(full)
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

})
