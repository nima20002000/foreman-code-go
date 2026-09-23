import { afterEach, describe, expect, it } from 'vitest'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { legacyApprovalFixture } from './helpers/wave25ApprovalFixture.js'
import { persistLegacyApprovalRelationships } from '../src/modules/workflows/approvalMigrationPersistence.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function setup() { const f = await approvalDatabase(); closes.push(f.close); return f }
describe('A4 persisted approval migration and older-writer protection', () => {
  it('rejects dropping the v2 marker, relationship kinds or approval assignments', async () => {
    const f = await setup()
    await expect(f.pool.query("update graph_drafts set record=record #- '{graph,executionSemanticsVersion}' where id=$1", [f.draft.id])).rejects.toMatchObject({ code: 'PGA01' })
    await expect(f.pool.query("update graph_drafts set record=record #- '{graph,edges,1,kind}' where id=$1", [f.draft.id])).rejects.toMatchObject({ code: 'PGA01' })
    await expect(f.pool.query("update graph_drafts set record=record #- '{graph,edges,1}' where id=$1", [f.draft.id])).rejects.toMatchObject({ code: 'PGA04' })
    expect((await f.draftService.getIfV2(f.operator.principal, f.run.workspaceId, f.run.workflowId, f.draft.id))?.graph.edges).toEqual(f.draft.graph.edges)
  })
  it('refuses in-place changes to an accepted v2 version', async () => {
    const f = await setup()
    await expect(f.pool.query("update workflow_versions set record=jsonb_set(record,'{definition,name}','\"changed\"'::jsonb) where id=$1", [f.version.id])).rejects.toMatchObject({ code: 'PGA02' })
  })
  it('materializes reverse legacy adjacency without reversing execution or rewriting active history', async () => {
    const f = await setup(), legacy = legacyApprovalFixture().version
    legacy.id = 'legacy-approval-version'; legacy.version = 2; legacy.definition.version = 2
    Object.assign(legacy.definition.edges[0]!, { source: 'node-worker', target: 'node-reviewer' })
    await f.pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record)
      values($1,$2,$3,2,$4,$5::jsonb)`, [legacy.id, legacy.workspaceId, legacy.workflowId, legacy.entryNodeId, JSON.stringify(legacy)])
    const converted = { ...f.draft, baseWorkflowVersionId: legacy.id, graph: { ...f.draft.graph,
      edges: [{ id: 'legacy-edge', kind: 'execution', source: 'node-worker', target: 'node-reviewer' }] } }
    const client = await f.pool.connect()
    try {
      await client.query('begin'); await client.query("select set_config('graphql.approval_writer','v2',true)")
      await client.query('update graph_drafts set base_workflow_version_id=$2,record=$3::jsonb where id=$1', [f.draft.id, legacy.id, JSON.stringify(converted)])
      await client.query('commit')
      await client.query('begin')
      const migrated = await persistLegacyApprovalRelationships(client, f.operator.principal, {
        workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, draftId: f.draft.id, expectedRevision: 0, sourceVersionId: legacy.id })
      await client.query('commit')
      expect(migrated.graph.edges[0]).toEqual(converted.graph.edges[0])
      expect(migrated.graph.edges.filter((edge) => edge.kind === 'approval')).toEqual([
        expect.objectContaining({ source: 'node-reviewer', target: 'node-worker', kind: 'approval' }),
      ])
      await client.query('begin')
      const replay = await persistLegacyApprovalRelationships(client, f.operator.principal, {
        workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, draftId: f.draft.id, expectedRevision: 1, sourceVersionId: legacy.id })
      await client.query('commit'); expect(replay.revision).toBe(1)
      expect((await f.pool.query('select record from workflow_versions where id=$1', [legacy.id])).rows[0].record).toEqual(legacy)
      expect((await f.pool.query('select record from runs where id=$1', [f.run.id])).rows[0].record).toEqual(f.run)
    } finally { await client.query('rollback').catch(() => undefined); client.release() }
  })
  it('User handler changes are explicit and preserve execution direction and native settings', async () => {
    const f = await setup(), before = (await f.pool.query('select record from agent_configuration_versions order by id')).rows
    const changed = await f.draftService.apply(f.operator.principal, 'http', { executionSemanticsVersion: 2,
      workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, draftId: f.draft.id, expectedRevision: 0,
      commandId: 'explicit-user-handler', operations: [{ type: 'workflow.set_approval', approval: { handler: 'user' } }] })
    expect(changed.value.draft.graph.approval).toEqual({ handler: 'user' })
    expect(changed.value.draft.graph.edges).toEqual(f.version.definition.edges.filter((edge) => edge.kind === 'execution'))
    expect((await f.pool.query('select record from agent_configuration_versions order by id')).rows).toEqual(before)
  })
})
