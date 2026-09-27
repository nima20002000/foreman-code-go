import { AgentSchema } from '@graphql/contracts'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentWorkflowSaveResultSchema, CurrentWorkflowReadResultSchema } from '@graphql/contracts/wave25'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'

describe.skipIf(!postgresEnabled)('ENG04 current full-definition durable edit parity', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { db = await currentDatabase() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  it.each(['approval', 'limits', 'low-limits', 'both', 'empty'] as const)('rejects invalid %s before staging and permits a corrected save', async (invalid) => {
    const t = await writerFixture(db, 'sequential'); fixtures.push(t)
    const graph = structuredClone(t.input.graph)
    if (invalid === 'approval' || invalid === 'both') graph.approval = { handler: 'orchestrator' }
    if (invalid === 'limits' || invalid === 'both') delete graph.executionPolicy
    if (invalid === 'low-limits') graph.executionPolicy = { ...graph.executionPolicy!, maxNodeExecutions: 1 }
    if (invalid === 'empty') { graph.nodes = []; graph.edges = []; graph.entryNodeId = null }
    const stage = { ...t.input, graph, expectedAgentConfigurationVersionIds: invalid === 'empty' ? {} : t.input.expectedAgentConfigurationVersionIds, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID() }
    const rejected = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stage })
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('GRAPH_INVALID')
    const mcp = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(mcp.result?.isError).toBe(true)
    expect(graphRpcValue(mcp.result)).toEqual({ error: { code: 'GRAPH_INVALID',
      message: rejected.json().error.message, details: rejected.json().error.details } })
    const issues = rejected.json().error.details.issues
    expect(issues).toHaveLength(invalid === 'both' ? 2 : 1)
    if (invalid === 'approval' || invalid === 'both') expect(issues).toContainEqual({
      code: 'ORCHESTRATOR_REQUIRED', path: ['approval', 'designatedOrchestratorAgentId'], message: 'Choose a reviewing orchestrator.',
    })
    if (invalid === 'limits' || invalid === 'both') expect(issues).toContainEqual({
      code: 'EXECUTION_LIMITS_REQUIRED', path: ['executionPolicy'], message: 'Set execution limits.',
    })
    if (invalid === 'low-limits') expect(issues).toContainEqual({
      code: 'EXECUTION_LIMIT_TOO_LOW', path: ['executionPolicy', 'maxNodeExecutions'],
      message: `Increase “Maximum node executions” to at least ${graph.nodes.length}.`, minimum: graph.nodes.length, actual: 1,
    })
    expect((await db.pool.query('select 1 from graph_edit_intents where workflow_id=$1', [t.input.workflowId])).rowCount).toBe(0)
    const corrected = { ...stage, graph: t.input.graph, expectedAgentConfigurationVersionIds: t.input.expectedAgentConfigurationVersionIds, commandId: randomUUID() }
    const staged = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, corrected)).result))
    expect(staged.intent?.state).toBe('staged')
    expect(staged.intent?.stagedDraft.graph).toEqual(t.input.graph)
    const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.input.workspaceId] } }])
    const deniedReply = await t.call(CURRENT_WORKFLOW_TOOLS.edits, corrected, denied.token)
    expect(deniedReply.result?.isError).toBe(true)
    expect(JSON.stringify(deniedReply.result)).toContain('ACCESS_DENIED')
    const intent = staged.intent!
    const published = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, {
      workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: corrected.draftId,
      intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId,
    })).result))
    expect(published.intent?.state).toBe('saved')
    const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.saved,
      { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result))
    expect(persisted.version).toEqual(published.intent?.result?.version)
  })
  it('rejects incompatible reviewer settings before staging and permits correction without changing native permissions', async () => {
    const t = await writerFixture(db, 'approval'); fixtures.push(t)
    const reviewerId = t.input.graph.approval!.designatedOrchestratorAgentId!
    const row = (await db.pool.query('select record,metadata_revision from agents where id=$1', [reviewerId])).rows[0]
    const agent = AgentSchema.parse(row.record)
    if (agent.harnessConfiguration?.harness !== 'codex') throw new Error('Expected Codex fixture')
    const edited = { ...agent, harnessConfiguration: { ...agent.harnessConfiguration,
      advanced: { ...agent.harnessConfiguration.advanced!, approvalsReviewer: 'user' as const } } }
    const stage = { ...t.input, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      stagedAgents: [{ agent: edited, baseRevision: Number(row.metadata_revision) }] }
    const rejected = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stage })
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error).toMatchObject({ code: 'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED',
      details: { issues: [{ path: ['approval', 'handler'] }] } })
    const mcp = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(mcp.result?.isError).toBe(true)
    expect(graphRpcValue(mcp.result)).toMatchObject({ error: { code: rejected.json().error.code, details: rejected.json().error.details } })
    expect((await db.pool.query('select 1 from graph_edit_intents where workflow_id=$1', [t.input.workflowId])).rowCount).toBe(0)
    const corrected = { ...stage, commandId: randomUUID(), graph: { ...stage.graph, approval: { handler: 'user' },
      edges: stage.graph.edges.filter((edge) => edge.kind === 'execution') } }
    const staged = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, corrected)).result))
    const intent = staged.intent!
    const published = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, {
      workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId,
      intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId,
    })).result))
    expect(published.intent?.state).toBe('saved')
    const saved = CurrentWorkflowReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.saved,
      { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result))
    expect(saved.version.approval).toEqual({ handler: 'user' })
    const persisted = AgentSchema.parse((await db.pool.query('select record from agents where id=$1', [reviewerId])).rows[0].record)
    expect(persisted.harnessConfiguration).toEqual(edited.harnessConfiguration)
  })
  it.each(['sequential', 'repeat'] as const)('%s stages and discards the exact private intent across HTTP and MCP', async (form) => {
    const t = await writerFixture(db, form); fixtures.push(t)
    const savedResponse = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: t.input })
    expect(savedResponse.statusCode, savedResponse.body).toBe(200)
    const saved = CurrentWorkflowSaveResultSchema.parse(savedResponse.json()).value
    const stage = { ...t.input, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
      graph: { ...saved.version.definition, name: 'Private edit' } }
    const staged = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stage })
    expect(staged.statusCode, staged.body).toBe(200)
    const read = CurrentEditReadResultSchema.parse(staged.json()), intent = read.intent!
    expect(intent.stagedDraft.graph.name).toBe('Private edit')
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).toEqual(staged.json())
    const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.input.workspaceId] } }])
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, denied.token)).result?.isError).toBe(true)
    const discard = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId,
      intentId: intent.id, action: 'discard_edits', commandId: intent.discardCommandId }
    const dropped = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, discard)).result))
    expect(dropped.intent?.state).toBe('discarded')
    const replay = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: discard })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(dropped)
    const persisted = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
    expect(persisted.json().version).toEqual(saved.version)
    expect((await db.pool.query('select 1 from workflow_versions where workflow_id=$1', [t.input.workflowId])).rowCount).toBe(1)
    expect((await db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'", [t.writer.principal.id])).rowCount).toBe(0)
  })
})
