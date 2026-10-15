import { describe, expect, it } from 'vitest'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

type Plan = { 'Node Type': string; 'Actual Rows': number; Plans?: Plan[] }

const recoveryQuery = `select id,record,host_key from ci_runs
  where state in ('starting','running') or record->>'collection'='pending'
    or (state in ('passed','failed','canceled','lost') and record#>>'{observation,status}'='unavailable')`

function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)]
}

describe.skipIf(!postgresEnabled)('CI recovery eligibility index', () => {
  it('reads every recovery branch through an index without scanning completed history', async () => {
    const database = await currentDatabase()
    try {
      await database.pool.query(`insert into workspaces(id,record) values('recovery-fixture','{}'::jsonb)`)
      await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
        select md5(n::text)::uuid,'recovery-fixture',md5(n::text)::uuid,'passed','{}'::jsonb
        from generate_series(1,6000) n`)
      const candidates = [
        { state: 'starting', record: {} },
        { state: 'running', record: {} },
        { state: 'passed', record: { collection: 'pending' } },
        { state: 'failed', record: { observation: { status: 'unavailable' } } },
        { state: 'canceled', record: { observation: { status: 'unavailable' } } },
        { state: 'lost', record: { observation: { status: 'unavailable' } } },
      ]
      for (const [index, candidate] of candidates.entries()) {
        await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
          values(md5($1)::uuid,'recovery-fixture',md5($1)::uuid,$2,$3::jsonb)`,
        [`candidate-${index}`, candidate.state, JSON.stringify(candidate.record)])
      }
      await database.pool.query('analyze ci_runs')
      expect((await database.pool.query(recoveryQuery)).rows).toHaveLength(candidates.length)
      const result = await database.pool.query(`explain (analyze,buffers,format json) ${recoveryQuery}`)
      const plan = result.rows[0]['QUERY PLAN'][0].Plan as Plan
      expect(plan['Actual Rows']).toBe(candidates.length)
      expect(nodes(plan).some(node => ['Index Scan', 'Bitmap Index Scan'].includes(node['Node Type']))).toBe(true)
      expect(nodes(plan).some(node => node['Node Type'] === 'Seq Scan')).toBe(false)
    } finally { await database.close() }
  }, 60_000)
})
