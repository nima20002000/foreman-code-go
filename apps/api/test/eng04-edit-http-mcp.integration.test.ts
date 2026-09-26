import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentWorkflowSaveResultSchema } from '@graphql/contracts/wave25'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'

describe.skipIf(!postgresEnabled)('ENG04 current full-definition durable edit parity', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { db = await currentDatabase() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
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
