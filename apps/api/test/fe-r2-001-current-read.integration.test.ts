import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { readRunCurrent } from '../src/modules/runs/liveSnapshot.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { currentPrincipal, currentRow, currentScope } from './helpers/feR2001Current.js'

// Explicitly opt-in, disposable database only. Uses transaction-local temporary
// tables and the existing index shapes; not a migration/real-provider test.
const url = process.env.FE_R2_001_TEST_DATABASE_URL
describe.skipIf(!url)('FE-R2-001 PostgreSQL long-history current read', () => {
  it('keeps current rows/payload bounded while explicit history pages remain available', async () => {
    const connection = new pg.Client({ connectionString: url! })
    await connection.connect()
    try {
      await connection.query('begin')
      await connection.query(`
        create temporary table runs (id text primary key,workspace_id text,workflow_id text,workflow_version_id text,record jsonb);
        create temporary table workflow_versions (id text primary key,workspace_id text,workflow_id text,record jsonb,execution_semantics_version smallint not null default 1);
        create temporary table harness_executions (id text primary key,run_id text,workflow_node_id text,attempt integer,record jsonb,
          unique(run_id,workflow_node_id,attempt));
        create temporary table run_activity (run_id text,sequence bigint,source text,kind text,harness_execution_id text,
          occurred_at timestamptz,payload jsonb,primary key(run_id,sequence));
        create temporary table run_cleanup_intents (run_id text primary key,pending boolean);
      `)
      const row = currentRow()
      const pin = currentScope
      await connection.query('insert into runs values($1,$2,$3,$4,$5::jsonb)',
        [pin.runId, pin.workspaceId, pin.workflowId, pin.workflowVersionId,
          JSON.stringify({ ...row.run, executionSemanticsVersion: 1, input: { privateBody: 'not-for-current-read'.repeat(1000) } })])
      await connection.query('insert into workflow_versions(id,workspace_id,workflow_id,record) values($1,$2,$3,$4::jsonb)',
        [pin.workflowVersionId, pin.workspaceId, pin.workflowId, JSON.stringify({
          id: pin.workflowVersionId, workspaceId: pin.workspaceId, workflowId: pin.workflowId,
          executionSemanticsVersion: 1, definition: { id: pin.workflowId, workspaceId: pin.workspaceId, nodes: [{ id: 'node-fe-r2' }] },
        })])
      await connection.query(`insert into harness_executions
        select 'e-'||n,$1,'node-fe-r2',n,jsonb_build_object('id','e-'||n,'runId',$1::text,
          'workflowNodeId','node-fe-r2','attempt',n,'state','running','input',repeat('private',100))
        from generate_series(1,1000) n`, [pin.runId])
      const seedActivity = async (from: number, through: number) => connection.query(`insert into run_activity
        select $1,n,'backend','run_state_changed',null,'2026-09-22T00:00:00Z'::timestamptz,
          jsonb_build_object('body',repeat('history',128)) from generate_series($2::bigint,$3::bigint) n`, [pin.runId, from, through])
      const statements: Array<{ sql: string; parameters: unknown[] }> = []
      const sql = { query: async (text: string, parameters: unknown[] = []) => {
        statements.push({ sql: text, parameters })
        return connection.query(text, parameters)
      } } as unknown as Pick<pg.Pool, 'query'>
      await seedActivity(1, 10)
      const short = await readRunCurrent(sql, pin)
      await seedActivity(11, 100000)
      await connection.query('analyze run_activity; analyze harness_executions; analyze runs; analyze workflow_versions')
      const long = await readRunCurrent(sql, pin)
      expect(statements).toHaveLength(2)
      expect(short?.executions).toHaveLength(1)
      expect(long?.executions).toEqual(short?.executions)
      expect(long?.executions[0]?.attempt).toBe(1000)
      expect({ ...short, asOfActivitySequence: 'same' }).toEqual({ ...long, asOfActivitySequence: 'same' })
      expect(JSON.stringify(long).length - JSON.stringify(short).length).toBe(4)
      expect(JSON.stringify(long)).not.toContain('privateBody')
      expect(long).not.toHaveProperty('activity')

      const statement = statements[1]!
      const explain = await connection.query(`explain (analyze,buffers,format json) ${statement.sql}`, statement.parameters)
      type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number; Plans?: Plan[] }
      const root = (explain.rows[0]['QUERY PLAN'] as Array<{ Plan: Plan }>)[0]!.Plan
      const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)]
      const activityAccess = flatten(root).filter((plan) => plan['Relation Name'] === 'run_activity')
      expect(activityAccess).toHaveLength(1)
      expect(activityAccess[0]!['Node Type']).toMatch(/Index/)
      expect(activityAccess[0]!['Actual Rows'] * activityAccess[0]!['Actual Loops']).toBeLessThanOrEqual(1)
      const executionAccess = flatten(root).filter((plan) => plan['Relation Name'] === 'harness_executions')
      expect(executionAccess).toHaveLength(1)
      expect(executionAccess[0]!['Actual Rows'] * executionAccess[0]!['Actual Loops']).toBeLessThanOrEqual(1)

      type Args = ConstructorParameters<typeof RunManagementService>
      const service = new RunManagementService(sql as pg.Pool, {} as Args[1], {
        getForWorkspace: async (workspace: string, run: string) => workspace === pin.workspaceId && run === pin.runId ? row.run : undefined,
      } as unknown as Args[2], {} as Args[3], {} as Args[4])
      const beforeDenied = statements.length
      await expect(service.current(currentPrincipal(false), pin)).rejects.toMatchObject({ status: 403 })
      expect(statements).toHaveLength(beforeDenied)
      const first = await service.events(currentPrincipal(), { workspaceId: pin.workspaceId, runId: pin.runId, limit: 50 })
      expect(first.items).toHaveLength(50)
      expect(first.pageInfo.nextCursor).toBe('50')
      const next = await service.events(currentPrincipal(), { workspaceId: pin.workspaceId, runId: pin.runId, afterSequence: 50, limit: 50 })
      expect(next.items[0]?.sequence).toBe(51)
      expect(next.items).toHaveLength(50)
      expect(statements.at(-1)?.parameters).toEqual([pin.runId, 50, 51])

      await connection.query(`update runs set record=record || jsonb_build_object('executionState','completed',
        'outcome','succeeded','finishedAt','2026-09-22T01:00:00.000Z') where id=$1`, [pin.runId])
      for (const pending of [true, false]) {
        await connection.query('insert into run_cleanup_intents values($1,$2) on conflict(run_id) do update set pending=excluded.pending', [pin.runId, pending])
        expect(await readRunCurrent(sql, pin)).toMatchObject({ cleanupPending: pending, settlement: 'unconfirmed', run: { outcome: 'succeeded' } })
      }
      console.info('FE-R2-001 database evidence', { shortHistory: 10, longHistory: 100000,
        currentBytesShort: Buffer.byteLength(JSON.stringify(short)), currentBytesLong: Buffer.byteLength(JSON.stringify(long)),
        activityAccess, executionAccess })
    } finally {
      await connection.query('rollback').catch(() => undefined)
      await connection.end()
    }
  }, 120000)
})
