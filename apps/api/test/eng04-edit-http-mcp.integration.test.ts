import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@graphql/contracts/management'
import {
  RepeatEditIntentSchema, RepeatEditReadResultSchema, RepeatEditStageInputSchema, RepeatSaveResultSchema,
  type RepeatEditIntent, type RepeatEditStageInput, type RepeatMutationInput,
} from '@graphql/contracts/wave25'
import { commandInputHash, PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RepeatAuthoringService } from '../src/modules/repeats/authoring.js'
import { headers, mcp, snapshot, writerDatabase, writerFixture,
  type WriterDatabase, type WriterFixture } from './eng04-writer-fixtures.js'

// Opt-in real PostgreSQL 17 + authenticated Fastify HTTP/Operator MCP. The
// existing fixture uses an isolated schema and explicitly scoped synthetic
// credentials. It has NO native Stop manager. No native facts are fabricated;
// the successful save cases have no Runs, and active work must remain blocked.
const enabled = process.env.ENG04_EDIT_POSTGRES === '1' && process.env.ENG04_WRITER_POSTGRES === '1'
type Source = 'http' | 'mcp'
describe.skipIf(!enabled)('ENG04 durable repeat edit-intent authenticated parity', () => {
  let db: WriterDatabase
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { db = await writerDatabase() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(withRun = false) {
    const t = await writerFixture(db, withRun)
    t.writer = await t.credential([
      { actions: ['capabilities:read'], scope: {} },
      { actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope: t.scope },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: [t.input.workspaceId] } },
    ])
    fixtures.push(t)
    return t
  }
  async function input(t: WriterFixture): Promise<RepeatEditStageInput> {
    const location = (await db.pool.query<{ revision: string }>(
      'select location_revision::text as revision from workspaces where id=$1', [t.input.workspaceId])).rows[0]!
    return RepeatEditStageInputSchema.parse({ ...t.input, action: 'stage_edits', draftId: `repeat-editor-${randomUUID()}`,
      expectedAgentConfigurationVersionIds: t.f.version.agentConfigurationVersionIds,
      expectedLocationRevision: Number(location.revision) })
  }
  const scope = (t: WriterFixture) => ({ workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
  const command = (intent: RepeatEditIntent, action: 'stop_and_save' | 'discard_edits') => ({
    workspaceId: intent.workspaceId, workflowId: intent.workflowId, draftId: intent.draftId, intentId: intent.id,
    action, commandId: action === 'stop_and_save' ? intent.advanceCommandId : intent.discardCommandId,
  })
  async function edit(t: WriterFixture, source: Source, payload: RepeatMutationInput) {
    if (source === 'http') {
      const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: headers(t.writer.token), payload })
      expect(response.statusCode, response.body).toBe(200)
      return RepeatEditReadResultSchema.parse(response.json())
    }
    const response = await mcp(t.app, t.writer.token, 'repeat_update', payload)
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true)
    return RepeatEditReadResultSchema.parse(response.structuredContent)
  }
  async function read(t: WriterFixture, intent: RepeatEditIntent, source: Source) {
    if (source === 'http') {
      const response = await t.app.inject({ method: 'GET', url: `${t.url}/edits?draftId=${encodeURIComponent(intent.draftId)}&intentId=${encodeURIComponent(intent.id)}`,
        headers: headers(t.writer.token) })
      expect(response.statusCode, response.body).toBe(200)
      return RepeatEditReadResultSchema.parse(response.json())
    }
    const response = await mcp(t.app, t.writer.token, 'repeat_get', { ...scope(t), action: 'read_edits',
      draftId: intent.draftId, intentId: intent.id })
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true)
    return RepeatEditReadResultSchema.parse(response.structuredContent)
  }
  async function stored(t: WriterFixture, id: string) {
    return RepeatEditIntentSchema.parse((await db.pool.query<{ record: unknown }>(
      'select record from graph_edit_intents where id=$1 and principal_id=$2', [id, t.writer.principal.id])).rows[0]!.record)
  }

  it.each(['http', 'mcp'] as const)('Stages privately via %s, replays across transports, then publishes exactly once', async (first) => {
    const t = await fixture(), other = first === 'http' ? 'mcp' : 'http', stage = await input(t)
    const baseline = await snapshot(t)
    const beforeDrafts = (await db.pool.query('select * from graph_drafts where workflow_id=$1', [t.input.workflowId])).rows
    const initial = await edit(t, first, stage), intent = initial.intent!
    expect(intent.state).toBe('staged')
    expect(intent.stagedDraft.repeat).toEqual(stage.repeat)
    expect(intent.stagedDraft.agentConfigurationVersionIds).toEqual(stage.expectedAgentConfigurationVersionIds)
    expect(intent.stagedDraft.locationRevision).toBe(stage.expectedLocationRevision)
    expect(intent.stops).toEqual([])
    expect(intent.saveInputHash).toBe(commandInputHash(intent.saveInput))
    expect(await snapshot(t)).toEqual(baseline)
    expect((await db.pool.query('select * from graph_drafts where workflow_id=$1', [t.input.workflowId])).rows).toEqual(beforeDrafts)
    expect(await edit(t, other, stage)).toEqual(initial)
    expect(await read(t, intent, 'http')).toEqual(initial)
    expect(await read(t, intent, 'mcp')).toEqual(initial)
    const stageReceipt = (await db.pool.query(`select input_hash,target_key,result from management_command_receipts
      where principal_id=$1 and operation='graph.stage_edits' and command_id=$2`, [t.writer.principal.id, stage.commandId])).rows
    expect(stageReceipt).toEqual([{ input_hash: commandInputHash(stage), target_key: `draft:${stage.draftId}`, result: { intentId: intent.id } }])

    const advance = command(intent, 'stop_and_save')
    const saved = await edit(t, other, advance)
    expect(saved.intent).toMatchObject({ state: 'saved', saveAttempted: true, saveInput: intent.saveInput })
    const result = saved.intent!.result!
    expect(result.revision).toBe(stage.expectedRevision + 1)
    expect(result.currentVersionId).not.toBe(stage.expectedWorkflowVersionId)
    expect(result.version.executionSemanticsVersion).toBe(3)
    const after = await snapshot(t)
    expect(after.versions).toHaveLength(baseline.versions.length + 1)
    expect(after.versions[0]).toEqual(baseline.versions[0])
    expect(after.publications).toHaveLength(1)
    expect(after.receipts).toEqual([{ operation: 'repeat.save', command_id: intent.saveInput.commandId, result }])
    expect(await stored(t, intent.id)).toEqual(saved.intent)
    // A lost Stage/advance reply is reconciled by its ORIGINAL identity, even
    // after the baseline revision has changed due to the acknowledged save.
    expect(await edit(t, first, advance)).toEqual(saved)
    expect(await edit(t, other, stage)).toEqual(saved)
    expect(await read(t, intent, first)).toEqual(saved)
    expect(await snapshot(t)).toEqual(after)
    const publicRead = await t.app.inject({ method: 'GET', url: t.url, headers: headers(t.writer.token) })
    expect(publicRead.statusCode).toBe(200)
    expect(publicRead.json()).toMatchObject(result)
    const rpc = await mcp(t.app, t.writer.token, 'repeat_get', scope(t))
    expect(rpc.isError).not.toBe(true)
    expect(rpc.structuredContent).toEqual(publicRead.json())
    expect((await db.pool.query(`select source,outcome from management_audit where principal_id=$1
      and action='repeat.save' and details->>'commandId'=$2`, [t.writer.principal.id, intent.saveInput.commandId])).rows)
      .toEqual([{ source: other, outcome: 'succeeded' }])
  })

  it('publishes a second v3->v3 staged edit and preserves independent layout without any executable layout version', async () => {
    const t = await fixture()
    const direct = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })
    expect(direct.statusCode, direct.body).toBe(200)
    const first = RepeatSaveResultSchema.parse(direct.json()).value
    const stage = { ...await input(t), commandId: randomUUID(), expectedRevision: first.revision,
      expectedWorkflowVersionId: first.currentVersionId, repeat: { ...t.input.repeat,
        blocks: t.input.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 3 })) } }
    const privateEdit = (await edit(t, 'mcp', stage)).intent!
    const before = await snapshot(t)
    // Presentation-only SQL fixture change; no native or settlement evidence.
    await db.pool.query(`update workflows set record=jsonb_set(record,'{nodes,0,position}','{"x":131,"y":241}') where id=$1`, [t.input.workflowId])
    const layout = await snapshot(t)
    expect(layout.versions).toEqual(before.versions)
    expect(layout.workflow[0]!.revision).toBe(before.workflow[0]!.revision)
    const saved = (await edit(t, 'http', command(privateEdit, 'stop_and_save'))).intent!
    expect(saved.state).toBe('saved')
    expect(saved.result!.version.definition.nodes[0]!.position).toEqual({ x: 131, y: 241 })
    expect(saved.result!.version.definition.repeat).toEqual(stage.repeat)
    expect(saved.result!.revision).toBe(first.revision + 1)
    expect((await snapshot(t)).versions.slice(0, 2)).toEqual(before.versions)
  })

  it.each(['http', 'mcp'] as const)('Discard via %s retires only private edits and never Stops or publishes active work', async (first) => {
    const t = await fixture(true), stage = await input(t), before = await snapshot(t)
    const run = (await db.pool.query('select * from runs where id=$1', [t.f.run.id])).rows
    const staged = (await edit(t, first, stage)).intent!
    expect(staged.stops).toHaveLength(1)
    expect(staged.affected[0]!.runId).toBe(t.f.run.id)
    const discarded = await edit(t, first, command(staged, 'discard_edits'))
    expect(discarded.intent).toMatchObject({ state: 'discarded', saveAttempted: false,
      stagedDraft: staged.stagedDraft, stops: staged.stops, saveInput: staged.saveInput })
    expect(await edit(t, first === 'http' ? 'mcp' : 'http', command(staged, 'discard_edits'))).toEqual(discarded)
    expect(await edit(t, first, stage)).toEqual(discarded)
    expect(await snapshot(t)).toEqual(before)
    expect((await db.pool.query('select * from runs where id=$1', [t.f.run.id])).rows).toEqual(run)
    expect((await db.pool.query(`select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'`, [t.writer.principal.id])).rows).toEqual([])
    expect((await db.pool.query(`select source,outcome from management_audit where principal_id=$1 and action='graph.discard_edits'`, [t.writer.principal.id])).rows)
      .toEqual([{ source: first, outcome: 'succeeded' }])
  })

  it('retains an exact active-Run intent when the real Stop owner is not composed; never manufactures closure', async () => {
    const t = await fixture(true), baseline = await snapshot(t), stage = await input(t)
    const run = (await db.pool.query('select * from runs where id=$1', [t.f.run.id])).rows
    const staged = (await edit(t, 'http', stage)).intent!
    const advanced = await edit(t, 'mcp', command(staged, 'stop_and_save'))
    expect(advanced.intent).toMatchObject({ state: 'blocked', saveAttempted: false,
      error: { code: 'REPEAT_STOP_UNAVAILABLE', uncertain: false }, stops: staged.stops, saveInput: staged.saveInput })
    expect(advanced.current).toHaveLength(1)
    expect(advanced.current[0]!.settled).toBe(false)
    expect(await snapshot(t)).toEqual(baseline)
    expect((await db.pool.query('select * from runs where id=$1', [t.f.run.id])).rows).toEqual(run)
    expect((await db.pool.query(`select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'`, [t.writer.principal.id])).rows).toEqual([])
    const direct = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token),
      payload: { ...t.input, commandId: randomUUID() } })
    expect(direct.statusCode).toBe(409)
    expect(direct.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
    expect((await edit(t, 'http', command(staged, 'discard_edits'))).intent!.state).toBe('discarded')
  })

  it('reserves save identities against direct-write bypass and rejects replacement Stage/advance identities', async () => {
    const t = await fixture(), stage = await input(t), initial = await edit(t, 'http', stage), intent = initial.intent!
    const before = await snapshot(t)
    const reserved = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: intent.saveInput })
    expect(reserved.statusCode).toBe(409)
    expect(reserved.json()).toMatchObject({ error: { code: 'GRAPH_EDIT_USE_INTENT' } })
    expect(await mcp(t.app, t.writer.token, 'repeat_update', intent.saveInput))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'GRAPH_EDIT_USE_INTENT' } } })
    for (const [payload, code] of [
      [{ ...stage, repeat: { ...stage.repeat, blocks: stage.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 1 })) } }, 'COMMAND_ID_CONFLICT'],
      [{ ...stage, commandId: randomUUID() }, 'GRAPH_EDIT_INTENT_EXISTS'],
      [{ ...command(intent, 'stop_and_save'), commandId: randomUUID() }, 'COMMAND_ID_CONFLICT'],
    ] as const) {
      const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: headers(t.writer.token), payload })
      expect(response.statusCode, response.body).toBe(409)
      expect(response.json()).toMatchObject({ error: { code } })
    }
    expect(await stored(t, intent.id)).toEqual(intent)
    expect(await snapshot(t)).toEqual(before)
  })

  it('denies read-only and wrong-scope Stage/advance/Discard on both authenticated surfaces with denial audit', async () => {
    const t = await fixture(), stage = await input(t), intent = (await edit(t, 'http', stage)).intent!
    const before = await snapshot(t)
    const reader = await t.credential([{ actions: ['workflows:read', 'graph:read', 'agents:read', 'workspace_locations:read', 'runs:read'], scope: t.scope }])
    const wrong = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['different-workspace'] } }])
    for (const actor of [reader, wrong]) {
      for (const payload of [stage, command(intent, 'stop_and_save'), command(intent, 'discard_edits')]) {
        const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: headers(actor.token), payload })
        // Private exact-command reads intentionally return 404 to a different
        // principal. Lack of Stage write grant is a definitive 403.
        expect([403, 404]).toContain(response.statusCode)
        const rpc = await mcp(t.app, actor.token, 'repeat_update', payload)
        expect(rpc.isError).toBe(true)
        const code = (rpc.structuredContent as { error: { code: string } }).error.code
        expect(payload.action === 'stage_edits' ? ['ACCESS_DENIED'] : ['ACCESS_DENIED', 'GRAPH_EDIT_INTENT_NOT_FOUND'])
          .toContain(code)
      }
      expect((await db.pool.query('select source,outcome from management_audit where principal_id=$1', [actor.principal.id])).rows)
        .toEqual(expect.arrayContaining([{ source: 'http', outcome: 'denied' }, { source: 'mcp', outcome: 'denied' }]))
    }
    expect(await stored(t, intent.id)).toEqual(intent)
    expect(await snapshot(t)).toEqual(before)
  })

  it('does not expose another same-scope writer\'s private payload, even with matching editor/intent IDs', async () => {
    const t = await fixture(), intent = (await edit(t, 'mcp', await input(t))).intent!
    const other = await t.credential([
      { actions: ManagementActionSchema.options, scope: t.scope },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: [t.input.workspaceId] } },
    ])
    const response = await t.app.inject({ method: 'GET', url: `${t.url}/edits?draftId=${intent.draftId}&intentId=${intent.id}`, headers: headers(other.token) })
    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('maxOccurrences')
    expect(await mcp(t.app, other.token, 'repeat_get', { ...scope(t), action: 'read_edits', draftId: intent.draftId, intentId: intent.id }))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'GRAPH_EDIT_INTENT_NOT_FOUND' } } })
  })

  it('rechecks live location/write grants before replay and advance even for a captured principal', async () => {
    const t = await fixture(), stage = await input(t), intent = (await edit(t, 'http', stage)).intent!
    const before = await snapshot(t)
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [t.writer.principal.id, JSON.stringify([
      { actions: ManagementActionSchema.options.filter((action) => action !== 'workspace_locations:read'), scope: t.scope },
    ])])
    const service = new RepeatAuthoringService(db.pool, new PostgresCommandCoordinator(db.pool), true)
    await expect(service.mutate(t.writer.principal, 'http', stage)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.mutate(t.writer.principal, 'mcp', command(intent, 'stop_and_save'))).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: headers(t.writer.token), payload: stage })
    expect(response.statusCode).toBe(403)
    expect(await mcp(t.app, t.writer.token, 'repeat_update', stage))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'ACCESS_DENIED' } } })
    expect(await stored(t, intent.id)).toEqual(intent)
    expect(await snapshot(t)).toEqual(before)
  })

  it.each(['workflow', 'location'] as const)('retains payload and identities after a changed %s baseline; Discard remains private', async (kind) => {
    const t = await fixture(), intent = (await edit(t, 'mcp', await input(t))).intent!
    if (kind === 'workflow') await db.pool.query('update workflows set revision=revision+1 where id=$1', [t.input.workflowId])
    else await db.pool.query('update workspaces set location_revision=location_revision+1 where id=$1', [t.input.workspaceId])
    const before = await snapshot(t)
    const result = await edit(t, 'http', command(intent, 'stop_and_save'))
    expect(result.intent).toMatchObject({ state: 'blocked', saveAttempted: false,
      stagedDraft: intent.stagedDraft, saveInput: intent.saveInput, stops: intent.stops,
      error: { code: kind === 'workflow' ? 'WORKFLOW_BASE_CONFLICT' : 'REPEAT_EDIT_LOCATION_CONFLICT' } })
    expect(await snapshot(t)).toEqual(before)
    expect((await edit(t, 'mcp', command(intent, 'discard_edits'))).intent!.state).toBe('discarded')
    expect(await snapshot(t)).toEqual(before)
  })

  it('rejects invalid budget, stale displayed pins, URL/body scope mismatch and unauthenticated mutation before Stage', async () => {
    const t = await fixture(), stage = await input(t), before = await snapshot(t)
    for (const [payload, status, code] of [
      [{ ...stage, expectedRevision: stage.expectedRevision + 1 }, 409, 'REVISION_CONFLICT'],
      [{ ...stage, expectedWorkflowVersionId: 'wrong-version' }, 409, 'WORKFLOW_BASE_CONFLICT'],
      [{ ...stage, expectedAgentConfigurationVersionIds: {} }, 409, 'AGENT_CONFIGURATION_CONFLICT'],
      [{ ...stage, expectedLocationRevision: stage.expectedLocationRevision + 1 }, 409, 'LOCATION_REVISION_CONFLICT'],
      [{ ...stage, repeat: { ...stage.repeat, blocks: stage.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 4 })) } }, 409, 'REPEAT_INVALID'],
      [{ ...stage, workflowId: 'wrong-url-scope' }, 400, 'RESOURCE_ID_MISMATCH'],
    ] as const) {
      const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: headers(t.writer.token), payload })
      expect(response.statusCode, response.body).toBe(status)
      expect(response.json()).toMatchObject({ error: { code } })
    }
    const noAuth = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: { host: 'localhost' }, payload: stage })
    expect(noAuth.statusCode).toBe(401)
    expect((await db.pool.query('select 1 from graph_edit_intents where workflow_id=$1', [t.input.workflowId])).rows).toEqual([])
    expect(await snapshot(t)).toEqual(before)
  })
})
