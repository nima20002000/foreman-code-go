import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { WAVE25_ADMISSION_ENABLED, RunGraphBatchSchema } from '@graphql/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { admitOneShotRun } from '../src/modules/runs/oneShotAdmission.js'
import { OneShotRunRepository } from '../src/modules/runs/oneShotPostgres.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, seedAgent3, candidateFor, graphHead, deferred, postgresEnabled } from './helpers/wave25Agent3.js'

/** Tests the actual SQL admission implementation directly in isolated fixtures.
 * Public admissions remain unconditionally OFF; no env-based bypass is added. */
describe.skipIf(!postgresEnabled)('Agent 3 atomic Run admission and live authorization', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { await db?.close() })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const table of ['runs', 'run_graph_batches', 'management_command_receipts']) await db.pool.query(`drop trigger if exists a3_admission_fault on ${table}`)
  })
  async function fixture() {
    const f = await seedAgent3(db.pool, db.directory, undefined, { run: false })
    const access = new PostgresAccessService(db.pool)
    const issued = await access.issue({ name: 'Synthetic Run authority', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }], expiresAt: new Date(Date.now() + 300_000) })
    const commands = new PostgresCommandCoordinator(db.pool)
    const locations = new WorkspaceLocationService(db.pool, commands, db.directory)
    // The FS probe is the only test double. SQL scope/revision/identity checks,
    // command receipts, Run authority and graph publication are all real.
    const snapshot = vi.spyOn(locations, 'snapshot').mockResolvedValue(f.run.executionLocation!)
    const input = { executionSemanticsVersion: 2 as const, workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      workflowVersionId: f.version.id, commandId: randomUUID(), expectedLocationRevision: 1, input: { user: 'synthetic private input' } }
    return { f, access, issued, commands, locations, snapshot, input }
  }
  it.each(['runs', 'run_graph_batches', 'management_command_receipts'] as const)('rolls back the entire admission if %s fails', async (table) => {
    const { f, issued, locations, input } = await fixture()
    await db.pool.query(`create or replace function a3_admission_crash() returns trigger language plpgsql as $$
      begin raise exception 'A3_ADMISSION_CRASH'; end $$`)
    await db.pool.query(`create trigger a3_admission_fault after insert on ${table} for each row execute function a3_admission_crash()`)
    await expect(admitOneShotRun(db.pool, locations, issued.principal, 'mcp', input)).rejects.toThrow('A3_ADMISSION_CRASH')
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(0)
    expect((await db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.start'", [issued.principal.id])).rowCount).toBe(0)
    expect((await db.pool.query('select 1 from management_principals where delegated_from=$1', [issued.principal.id])).rowCount).toBe(0)
    await db.pool.query(`drop trigger a3_admission_fault on ${table}`)
    const result = await admitOneShotRun(db.pool, locations, issued.principal, 'mcp', input)
    const sequence = await graphHead(db.pool, result.value.id)
    const body = (await db.pool.query<{ payload: string }>('select payload from run_graph_batches where run_id=$1 and sequence=$2::bigint', [result.value.id, sequence])).rows[0]!.payload
    const batch = RunGraphBatchSchema.parse(JSON.parse(body))
    expect(batch.events.map((event) => event.fact.type)).toEqual(['run.state'])
    expect(body).not.toContain('synthetic private input')
    expect((await db.pool.query('select 1 from run_authority_principals where run_id=$1', [result.value.id])).rowCount).toBe(1)
  })
  it('replays one durable Run without probing the filesystem or creating another execution', async () => {
    const { f, issued, locations, snapshot, input } = await fixture()
    const first = await admitOneShotRun(db.pool, locations, issued.principal, 'http', input)
    snapshot.mockRejectedValue(new Error('directory now unavailable'))
    const replay = await admitOneShotRun(db.pool, locations, issued.principal, 'mcp', input)
    expect(replay).toEqual({ ...first, replayed: true }); expect(snapshot).toHaveBeenCalledTimes(1)
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(1)
    await expect(admitOneShotRun(db.pool, locations, issued.principal, 'mcp', { ...input, input: { changed: true } })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })
  it('rejects a location revision changed during external validation before any Run/receipt is created', async () => {
    const { f, issued, locations, snapshot, input } = await fixture()
    snapshot.mockImplementation(async () => {
      await db.pool.query('update workspaces set location_revision=location_revision+1 where id=$1', [f.scope.workspaceId])
      return f.run.executionLocation!
    })
    await expect(admitOneShotRun(db.pool, locations, issued.principal, 'http', input)).rejects.toMatchObject({ code: 'LOCATION_REVISION_CONFLICT' })
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(0)
  })
  it('rejects stale pins and revoked authority, including replay under revoked credentials', async () => {
    const { f, issued, locations, input } = await fixture()
    const first = await admitOneShotRun(db.pool, locations, issued.principal, 'mcp', input)
    await db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [issued.principal.id])
    await expect(admitOneShotRun(db.pool, locations, issued.principal, 'mcp', input)).rejects.toThrow()
    const other = await fixture()
    await db.pool.query('update agents set current_configuration_version_id=null where id=$1', [other.f.configurations[0]!.agentId])
    await expect(admitOneShotRun(db.pool, other.locations, other.issued.principal, 'mcp', other.input)).rejects.toMatchObject({ code: 'WORKFLOW_CONFIGURATION_STALE' })
    expect((await db.pool.query('select 1 from runs where id=$1 and workflow_id=$2', [first.value.id, f.scope.workflowId])).rowCount).toBe(1)
  })
  it('serializes independent admissions at the runner bound rather than deriving capacity from node count', async () => {
    const a = await fixture(), b = await fixture(), runner = `runner-${randomUUID()}`
    for (const value of [a, b]) {
      value.f.run.executionLocation!.runnerId = runner
      value.snapshot.mockResolvedValue(value.f.run.executionLocation!)
      await db.pool.query("update workspaces set execution_location=jsonb_set(execution_location,'{runnerId}',to_jsonb($2::text)) where id=$1", [value.f.scope.workspaceId, runner])
    }
    const results = await Promise.allSettled([a, b].map((value) => admitOneShotRun(db.pool, value.locations, value.issued.principal, 'mcp', value.input, { maximumResidentRuns: 1 })))
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({ reason: { code: 'RUNNER_ADMISSION_FULL' } })
    expect((await db.pool.query('select 1 from runs where runner_id=$1', [runner])).rowCount).toBe(1)
  })
  it('holds live root authority against a revocation race until the effect transaction commits', async () => {
    const { f, issued, locations, input } = await fixture()
    const accepted = await admitOneShotRun(db.pool, locations, issued.principal, 'mcp', input)
    f.run = accepted.value; f.scope.runId = accepted.value.id
    const owner = await RunOwnership.acquire(db.pool, accepted.value.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    const entered = deferred(), release = deferred()
    let pause = true
    const store = new OneShotRunRepository(owner, async (sql, run) => {
      if (pause) { pause = false; entered.resolve(); await release.promise } // test-only locked-authority latch
      await locations.revalidateRunAuthorization(run.authorizationPrincipalId!, run.workspaceId, run.workflowId,
        sql as unknown as Parameters<typeof locations.revalidateRunAuthorization>[3])
    })
    try {
      const queued = store.admit(f.version.entryNodeId, () => candidateFor(f))
      await entered.promise
      let revoked = false
      const revocation = db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [issued.principal.id]).then(() => { revoked = true })
      await new Promise((resolve) => setTimeout(resolve, 20)); expect(revoked).toBe(false)
      release.resolve(); const row = await queued; await revocation
      if (row.kind !== 'admitted') throw new Error('Expected admitted execution')
      await expect(store.claimLaunch(row.execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/never-created` })).rejects.toThrow()
      expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [accepted.value.id])).rowCount).toBe(0)
      // Revocation forbids native work, not the owner settling the admitted
      // negative attempt. Otherwise revoked permission would strand dependents.
      await store.failExecution(row.execution.id, 'RUN_AUTHORIZATION_REVOKED')
      const negative = await db.pool.query<{ resolution: string }>('select resolution from run_node_resolutions where run_id=$1 and workflow_node_id=$2',
        [accepted.value.id, f.version.entryNodeId])
      expect(negative.rows[0]!.resolution).toBe('failed')
      await store.settleRun(false)
      expect((await db.pool.query<{ execution_state: string }>('select execution_state from runs where id=$1', [accepted.value.id])).rows[0]!.execution_state).toBe('completed')

    } finally { release.resolve(); await owner.release() }
  })
  it('rejects cross-Run writes before an owner can mutate a different Run', async () => {
    const a = await fixture(), b = await fixture()
    const first = await admitOneShotRun(db.pool, a.locations, a.issued.principal, 'mcp', a.input)
    const second = await admitOneShotRun(db.pool, b.locations, b.issued.principal, 'mcp', b.input)
    const owner = await RunOwnership.acquire(db.pool, first.value.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    const repository = new PostgresRunRepository(db.pool, new PostgresWorkflowRepository(db.pool), a.locations)
    try {
      await expect(repository.get(second.value.id, owner)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
      await expect(repository.updateState(second.value.id, { executionState: 'interrupted', outcome: 'pending' }, owner))
        .rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
      expect((await repository.get(second.value.id))!.executionState).toBe('queued')
      expect((await repository.get(first.value.id))!.executionState).toBe('queued')
    } finally { await owner.release() }
  })
  it('retains the frozen public rollout gate without any synthetic-mode environment bypass', async () => {
    const { f, issued, commands, locations, input, snapshot } = await fixture()
    const runs = new PostgresRunRepository(db.pool, new PostgresWorkflowRepository(db.pool), locations)
    const start = vi.fn(async () => undefined)
    const management = new RunManagementService(db.pool, commands, runs, { start } as unknown as LangGraphWorkflowEngine, locations)
    expect(WAVE25_ADMISSION_ENABLED).toBe(false)
    await expect(management.start(issued.principal, 'mcp', input)).rejects.toThrow('EXECUTION_SEMANTICS_ROLLOUT_DISABLED')
    expect(start).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
    expect((await db.pool.query('select 1 from runs where workflow_id=$1', [f.scope.workflowId])).rowCount).toBe(0)
  })
})
