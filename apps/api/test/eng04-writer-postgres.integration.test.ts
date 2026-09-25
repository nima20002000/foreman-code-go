import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { RepeatSaveResultSchema, type RepeatSaveInput, type RepeatWorkflowVersionV1 } from '@graphql/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import {
  candidateFor, contentJson, headers, insertCandidate, mcp, publishCandidate, rejectSql, snapshot, transaction,
  writerDatabase, writerFixture, writerPostgresEnabled, type WriterDatabase, type WriterFixture,
} from './eng04-writer-fixtures.js'

// SQL clients below use only the disposable test database's ordinary application
// role. No trigger disabling, replica mode, SECURITY DEFINER, or role changes.
describe.skipIf(!writerPostgresEnabled)('ENG04 typed repeat writer PostgreSQL contract', () => {
  let db: WriterDatabase
  const apps: WriterFixture['app'][] = []
  beforeAll(async () => { db = await writerDatabase() }, 120000)
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture() { const t = await writerFixture(db); apps.push(t.app); return t }
  async function saved(t: WriterFixture) {
    const response = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })
    expect(response.statusCode, response.body).toBe(200)
    return RepeatSaveResultSchema.parse(response.json()).value
  }
  async function rawUpdate(sql: pg.PoolClient, t: WriterFixture, candidate: RepeatWorkflowVersionV1) {
    await insertCandidate(sql, candidate)
    // This is precisely the old authoring UPDATE, without the new operation.
    await sql.query(`update workflows set current_version_id=$3,record=$4::jsonb,revision=revision+1
      where workspace_id=$1 and id=$2 and revision=$5 returning revision::text`,
    [t.input.workspaceId, t.input.workflowId, candidate.id, JSON.stringify(candidate.definition), t.input.expectedRevision])
  }

  it('reproduces historical PGA01, then applies only the additive migration and publishes through HTTP/MCP', async () => {
    const legacy = await writerDatabase(true)
    let t: WriterFixture | undefined
    try {
      t = await writerFixture(legacy)
      const target = t, candidate = await candidateFor(target)
      const oldLedger = (await legacy.pool.query('select version,applied_at from application_migrations order by version')).rows
      const oldVersion = (await legacy.pool.query('select record,xmin::text,ctid::text from workflow_versions where id=$1', [t.f.version.id])).rows
      const trigger = async () => (await legacy.pool.query(`select t.oid::text,t.tgfoid::text,t.tgenabled,p.proowner::text,p.proacl::text
        from pg_trigger t join pg_proc p on p.oid=t.tgfoid
        where t.tgrelid='workflows'::regclass and t.tgname='wave25_approval_workflow_writer'`)).rows
      const oldTrigger = await trigger()
      expect(oldTrigger).toHaveLength(1)
      expect(oldTrigger[0]).toMatchObject({ tgenabled: 'O' })
      let observed: { code?: string; message?: string; where?: string } | undefined
      try { await transaction(legacy.pool, (sql) => rawUpdate(sql, target, candidate)) }
      catch (error) { observed = error as typeof observed }
      expect(observed).toMatchObject({ code: 'PGA01', message: 'APPROVAL_OLDER_WRITER_REJECTED',
        where: expect.stringContaining('wave25_approval_no_downgrade() line 12') })
      expect((await legacy.pool.query('select count(*)::int as count from workflow_versions where workflow_id=$1', [t.input.workflowId])).rows[0]!.count).toBe(1)
      await applyApplicationMigrations(legacy.pool)
      await applyApplicationMigrations(legacy.pool) // ordinary registry retry, not direct SQL reapplication
      expect((await legacy.pool.query('select version,applied_at from application_migrations where version<>264502 order by version')).rows).toEqual(oldLedger)
      expect((await legacy.pool.query('select count(*)::int as count from application_migrations where version=264502')).rows[0]!.count).toBe(1)
      expect(await trigger()).toEqual(oldTrigger) // original trigger/function identity and ACL survive
      const result = await saved(t)
      const rpc = await mcp(t.app, t.writer.token, 'repeat_get', { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
      expect(rpc.isError).not.toBe(true)
      expect(rpc.structuredContent).toEqual({ contractVersion: 1, executionSemanticsVersion: 3, ...result })
      expect((await legacy.pool.query('select record,xmin::text,ctid::text from workflow_versions where id=$1', [t.f.version.id])).rows).toEqual(oldVersion)
    } finally { await t?.app.close(); await legacy.close() }
  }, 120000)

  it.each([false, true])('rejects the old bare SQL writer (old/new GUC flags present: %s)', async (flags) => {
    const t = await fixture(), candidate = await candidateFor(t)
    await rejectSql(t, async (sql) => {
      // A regression probe, NOT the implementation: an arbitrary setting is not
      // publication authority, even when the historical v2 marker is present.
      if (flags) await sql.query("select set_config('graphql.approval_writer','v2',true),set_config('graphql.repeat_writer','v3',true)")
      await rawUpdate(sql, t, candidate)
    }, 'PGR01', 'REPEAT_TYPED_WRITER_REQUIRED')
  })

  it('rolls the entire typed operation back at COMMIT without the exact command receipt and success audit', async () => {
    const t = await fixture(), candidate = await candidateFor(t)
    await rejectSql(t, async (sql) => {
      await insertCandidate(sql, candidate)
      expect((await publishCandidate(sql, t, candidate)).rows[0]!.revision).toBe('2')
      // The update itself succeeded inside this transaction, but cannot commit.
    }, 'PGR04', 'REPEAT_ATOMIC_RECEIPT_REQUIRED')
  })

  it.each(['wrong_hash', 'wrong_result', 'missing_audit', 'wrong_source'] as const)('rejects a mismatched atomic command proof: %s', async (fault) => {
    const t = await fixture(), candidate = await candidateFor(t)
    await rejectSql(t, async (sql) => {
      await insertCandidate(sql, candidate)
      await publishCandidate(sql, t, candidate)
      const result = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, revision: 2,
        currentVersionId: candidate.id, version: candidate }
      await sql.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
        values($1,'repeat.save',$2,$3,$4,$5::jsonb)`, [t.writer.principal.id, t.input.commandId,
      `workflow:${t.input.workflowId}:repeat`, fault === 'wrong_hash' ? 'sha256:' + '0'.repeat(64) : commandInputHash(t.input),
      JSON.stringify(fault === 'wrong_result' ? { ...result, currentVersionId: t.f.version.id } : result)])
      if (fault !== 'missing_audit') await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,$2,'repeat.save',$3,'succeeded',$4::jsonb)`, [t.writer.principal.id, fault === 'wrong_source' ? 'mcp' : 'http',
      `workflow:${t.input.workflowId}:repeat`, JSON.stringify({ commandId: t.input.commandId })])
    }, 'PGR04', 'REPEAT_ATOMIC_RECEIPT_REQUIRED')
  })

  it('rejects denied SQL callers and narrowed delegated-owner authority without changing privileges', async () => {
    const t = await fixture(), candidate = await candidateFor(t)
    const readOnly = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: t.scope }])
    await rejectSql(t, async (sql) => {
      await insertCandidate(sql, candidate)
      await publishCandidate(sql, t, candidate, t.input, readOnly.principal.id)
    }, 'PGR05', 'REPEAT_PUBLICATION_ACCESS_DENIED')
    // The child still carries broad grants; live ancestry must remain binding.
    await db.pool.query('update management_principals set delegated_from=$2 where id=$1', [t.writer.principal.id, readOnly.principal.id])
    await rejectSql(t, async (sql) => {
      await insertCandidate(sql, candidate)
      await publishCandidate(sql, t, candidate)
    }, 'PGR05', 'REPEAT_PUBLICATION_ACCESS_DENIED')
  })

  const planFaults = ['zero_cap', 'fractional_cap', 'string_cap', 'oversized_cap', 'budget', 'duplicate_block',
    'duplicate_member', 'unknown_member', 'wrong_entry', 'overlap', 'same_outcomes', 'missing_outcome', 'wrong_limit', 'unknown_field'] as const
  it.each(planFaults)('rejects raw SQL invalid repeat plans: %s', async (fault) => {
    const t = await fixture(), candidate = await candidateFor(t)
    const plan = candidate.definition.repeat, block = plan.blocks[0]!
    switch (fault) {
      case 'zero_cap': block.maxOccurrences = 0; break
      case 'fractional_cap': block.maxOccurrences = 1.5; break
      case 'string_cap': Object.assign(block, { maxOccurrences: '2' }); break
      case 'oversized_cap': block.maxOccurrences = 2147483648; break
      case 'budget': block.maxOccurrences = 4; break
      case 'duplicate_block': plan.blocks.push(structuredClone(block)); break
      case 'duplicate_member': block.nodeIds.push(block.nodeIds[0]!); break
      case 'unknown_member': block.nodeIds.push('absent'); break
      case 'wrong_entry': block.entryNodeId = block.exitNodeId; break
      case 'overlap': plan.blocks.push({ ...structuredClone(block), id: 'overlap' }); break
      case 'same_outcomes': block.earlyExitOutcome = block.repeatOutcome; break
      case 'missing_outcome': block.earlyExitOutcome = 'not_declared'; break
      case 'wrong_limit': block.limitExit = { kind: 'edge', relationshipId: t.f.version.definition.edges[0]!.id }; break
      case 'unknown_field': Object.assign(plan, { arbitraryCycles: true }); break
    }
    const input: RepeatSaveInput = { ...t.input, repeat: plan }, witness = contentJson(candidate)
    await rejectSql(t, async (sql) => {
      await insertCandidate(sql, candidate)
      await publishCandidate(sql, t, candidate, input, t.writer.principal.id, witness)
    }, 'PGR03', 'REPEAT_')
  })

  it.each(['approval', 'reviewer_edge', 'execution_edge', 'configuration_pin', 'physical_version', 'physical_entry', 'hash', 'content'] as const)(
    'rejects a mismatched immutable publication or changed non-repeat semantics: %s', async (fault) => {
      const t = await fixture(), candidate = await candidateFor(t)
      switch (fault) {
        case 'approval': Object.assign(candidate.approval, { handler: 'orchestrator', designatedOrchestratorAgentId: t.f.configurations[0]!.agentId });
          candidate.definition.approval = candidate.approval; break
        case 'reviewer_edge': candidate.definition.edges.push({ id: 'injected-reviewer', kind: 'approval',
          source: candidate.definition.nodes[0]!.id, target: candidate.definition.nodes[1]!.id }); break
        case 'execution_edge': candidate.definition.edges = []; break
        case 'configuration_pin': candidate.agentConfigurationVersionIds[t.f.configurations[0]!.agentId] = 'different-immutable-pin'; break
      }
      let witness = contentJson(candidate)
      if (fault === 'hash') candidate.contentHash = 'sha256:' + 'f'.repeat(64)
      if (fault === 'content') witness = '{}'
      await rejectSql(t, async (sql) => {
        await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
          values($1,$2,$3,$4,$5,$6::jsonb,3)`, [candidate.id, candidate.workspaceId, candidate.workflowId,
        candidate.version + (fault === 'physical_version' ? 1 : 0), fault === 'physical_entry' ? 'absent' : candidate.entryNodeId, JSON.stringify(candidate)])
        await publishCandidate(sql, t, candidate, t.input, t.writer.principal.id, witness)
      }, 'PGR02', 'REPEAT_IMMUTABLE_VERSION_MISMATCH')
    })

  it('requires the exact revision/base even for a direct typed operation', async () => {
    const t = await fixture(), candidate = await candidateFor(t)
    for (const input of [{ ...t.input, expectedRevision: 2 }, { ...t.input, expectedWorkflowVersionId: 'absent' }]) {
      await rejectSql(t, async (sql) => {
        await insertCandidate(sql, candidate)
        await publishCandidate(sql, t, candidate, input)
      }, 'PGR02', 'REPEAT_BASE_CONFLICT')
    }
  })

  it('rejects v3 downgrade, pointer-only downgrade, malformed tags, direct repeat edits and immutable-history rewrites', async () => {
    const t = await fixture(), first = await saved(t)
    for (const update of [
      `update workflows set record=$2::jsonb,current_version_id=$3 where id=$1`,
      `update workflows set current_version_id=$3 where id=$1 and $2::jsonb is not null`,
    ]) await rejectSql(t, (sql) => sql.query(update, [t.input.workflowId, JSON.stringify(t.f.version.definition), t.f.version.id]),
      'PGA01', 'APPROVAL_OLDER_WRITER_REJECTED')
    for (const tag of ['"3"', '4', '2', 'null']) await rejectSql(t, (sql) => sql.query(
      `update workflows set record=jsonb_set(record,'{executionSemanticsVersion}',$2::jsonb) where id=$1`, [t.input.workflowId, tag]),
    'PGA01', 'APPROVAL_OLDER_WRITER_REJECTED')
    for (const update of [
      `update workflows set record=jsonb_set(record,'{repeat,blocks,0,maxOccurrences}','1') where id=$1`,
      `update workflows set record=jsonb_set(record,'{approval}','{"handler":"orchestrator"}') where id=$1`,
      `update workflows set revision=revision-1 where id=$1`,
    ]) await rejectSql(t, (sql) => sql.query(update, [t.input.workflowId]), 'PGR01', 'REPEAT_TYPED_WRITER_REQUIRED')
    await rejectSql(t, (sql) => sql.query(`update workflow_versions set record=jsonb_set(record,'{definition,repeat,blocks,0,maxOccurrences}','1') where id=$1`,
      [first.currentVersionId]), 'P0001', 'REPEAT_VERSION_IMMUTABLE')
    for (const statement of [
      'update repeat_workflow_publications set expected_revision=expected_revision+1 where workflow_id=$1',
      'delete from repeat_workflow_publications where workflow_id=$1',
    ]) await rejectSql(t, (sql) => sql.query(statement, [t.input.workflowId]), 'PGR06', 'REPEAT_PUBLICATION_IMMUTABLE')
    await rejectSql(t, (sql) => sql.query('truncate repeat_workflow_publications'), 'PGR06', 'REPEAT_PUBLICATION_IMMUTABLE')
    // Reusing the already committed command in the SQL operation is not a replay.
    const nextInput = { ...t.input, expectedRevision: first.revision, expectedWorkflowVersionId: first.currentVersionId }
    const next = await candidateFor(t, nextInput)
    await rejectSql(t, async (sql) => {
      await insertCandidate(sql, next)
      await publishCandidate(sql, t, next, nextInput)
    }, 'PGR04', 'REPEAT_RECEIPT_ALREADY_EXISTS')
  })

  it('keeps v2 record and draft guards, while allowing independent v3 presentation changes', async () => {
    const t = await fixture()
    for (const expr of ["record-'entryNodeId'", "jsonb_set(record,'{executionSemanticsVersion}','1')",
      "jsonb_set(record,'{edges,0}',(record#>'{edges,0}')-'kind')"]) {
      await rejectSql(t, (sql) => sql.query(`update workflows set record=${expr} where id=$1`, [t.input.workflowId]),
        'PGA01', 'APPROVAL_OLDER_WRITER_REJECTED')
    }
    await rejectSql(t, (sql) => sql.query(`update workflows set record=jsonb_set(record,'{approval}','{"handler":"orchestrator"}') where id=$1`,
      [t.input.workflowId]), 'PGA04', 'APPROVAL_TYPED_WRITER_REQUIRED')
    const draftId = randomUUID()
    await db.pool.query(`insert into graph_drafts(id,workspace_id,workflow_id,revision,base_workflow_version_id,record)
      values($1,$2,$3,1,$4,$5::jsonb)`, [draftId, t.input.workspaceId, t.input.workflowId, t.f.version.id,
    JSON.stringify({ graph: t.f.version.definition })])
    const draft = (await db.pool.query('select record from graph_drafts where id=$1', [draftId])).rows
    await expect(transaction(db.pool, (sql) => sql.query(`update graph_drafts set record=jsonb_set(record,'{graph,executionSemanticsVersion}','1') where id=$1`,
      [draftId]))).rejects.toMatchObject({ code: 'PGA01', message: 'APPROVAL_OLDER_WRITER_REJECTED' })
    expect((await db.pool.query('select record from graph_drafts where id=$1', [draftId])).rows).toEqual(draft)
    const first = await saved(t), before = await snapshot(t)
    await db.pool.query(`update workflows set record=jsonb_set(jsonb_set(record,'{name}','"Renamed repeat"'),'{nodes,0,position}','{"x":12,"y":34}'),
      revision=revision+1 where id=$1`, [t.input.workflowId])
    const displayed = await snapshot(t)
    expect(displayed.workflow[0]!.record.name).toBe('Renamed repeat')
    expect(displayed.workflow[0]!.record.nodes[0].position).toEqual({ x: 12, y: 34 })
    expect(displayed.versions).toEqual(before.versions)
    const input = { ...t.input, commandId: randomUUID(), expectedRevision: first.revision + 1, expectedWorkflowVersionId: first.currentVersionId }
    const response = await mcp(t.app, t.writer.token, 'repeat_update', input)
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true)
    const result = RepeatSaveResultSchema.parse(response.structuredContent)
    expect(result.value.version.definition.name).toBe('Renamed repeat')
    expect(result.value.version.definition.nodes[0]!.position).toEqual({ x: 12, y: 34 })
  })
})
