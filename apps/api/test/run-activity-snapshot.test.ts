import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { WorkflowVersionV3 } from '@graphql/contracts/wave25'
import { readRunActivitySnapshot } from '../src/modules/runs/activitySnapshot.js'
import { projectNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'

const scope = { workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version' }
const version = { id: 'version', workspaceId: 'ws', workflowId: 'wf', definition: { nodes: [], edges: [] } } as unknown as WorkflowVersionV3
function fixture(moving = false) {
  let reads = 0
  const sql = { query: async (text: string) => {
    if (text.includes('from runs where')) { reads++; return { rows: [{ revision: moving && reads > 1 ? '4' : '3', stopped: false, outcome: 'pending', execution_state: 'running' }] } }
    if (text.includes('from harness_executions e left join')) return { rows: [
      { id: 'A', attempt: 1, revision: '7', native_revision: '0', state: 'running', outcome: null, started_at: '2026-10-01T00:00:00.000Z', native_session_id: 'native-A', harness: 'codex' },
      { id: 'C', attempt: 2, revision: '2', native_revision: '0', state: 'waiting', outcome: null, started_at: '2026-10-01T00:00:01.000Z', native_session_id: 'native-C', harness: 'codex' },
      { id: 'B', attempt: 1, revision: '0', native_revision: '0', state: 'queued', outcome: null, started_at: null, native_session_id: null, harness: 'codex' }] }
    if (text.includes('from durable_interactions')) return { rows: [] }
    if (text.includes('as high_water')) return { rows: [{ high_water: '9007199254740993', retained_from: '1', observed: 1 }] }
    if (text.startsWith('select a.sequence') || text.startsWith('with normalized')) return { rows: [] }
    throw new Error(`Unexpected snapshot SQL ${text}`)
  } } as unknown as Pick<pg.PoolClient, 'query'>
  return sql
}
describe('Run activity snapshot', () => {
  it('keeps two active executions, queued newest B, and independent exact source revisions', async () => {
    const value = await readRunActivitySnapshot(fixture(), scope, version)
    expect(value.active.map((entry) => entry.ref)).toMatchObject([{ executionId: 'A', attemptKey: '1' }, { executionId: 'C', attemptKey: '2' }])
    expect(value.queued).toMatchObject([{ executionId: 'B' }]); expect(value.latest).toEqual(value.queued[0])
    expect(value.revision).toBe('3'); expect(value.sourceRevisions).toContainEqual({ source: 'run_activity', id: 'run', revision: '9007199254740993' })
  })
  it('rejects a torn READ COMMITTED body rather than stamping it with a later revision', async () => {
    await expect(readRunActivitySnapshot(fixture(true), scope, version)).rejects.toMatchObject({ code: 'ACTIVITY_SNAPSHOT_CONFLICT' })
  })
  it('does not settle unresolved native children with their parent or invent their session', () => {
    const row = { execution_id: 'A', sequence: '4', item_id: 'child', item_type: 'subagent', status: 'running', native_session_id: null,
      native_turn_id: 'child-turn', generation: null, observed_at: null }
    const context = () => ({ owner: { kind: 'run' as const, ...scope }, harness: 'codex', sessionId: 'parent-session', terminal: true })
    const result = projectNativeActivityFacts([row], context)
    expect(result.active[0]).toMatchObject({ outcome: null, evidence: 'unknown' }); expect(result.active[0]?.native).toBeUndefined()
    expect(projectNativeActivityFacts([{ ...row, status: 'completed', native_session_id: 'child-session' }], context).active).toEqual([])
    expect(JSON.stringify(result)).not.toContain('parent-session')
  })
})
