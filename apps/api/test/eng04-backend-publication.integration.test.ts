import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { makeWave25Fixture, WorkflowVersionV2Schema, type RepeatSaveInput } from '@graphql/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RepeatAuthoringService } from '../src/modules/repeats/authoring.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

// Real PostgreSQL and live command authority; no fake native adapter, no server,
// no migration bypass. Uses the existing opt-in loopback/disposable-DB guard.
// Positive v3 runtime/admission remains a separate, unqualified integration gate.
describe.skipIf(!postgresEnabled)('ENG04 backend PostgreSQL publication rejection fences', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { await db?.close() })

  async function fixture(withRun = false) {
    const f = makeWave25Fixture(randomUUID())
    const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
    f.version = WorkflowVersionV2Schema.parse({ ...f.version, definition: { ...f.version.definition,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 4 }, nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }],
    } })
    await seedAgent3(db.pool, db.directory, f, { run: withRun })
    const access = new PostgresAccessService(db.pool)
    const { principal } = await access.issue({ name: 'Synthetic ENG04 publication writer', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }],
      expiresAt: new Date(Date.now() + 300000) })
    const revision = Number((await db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.version.workflowId])).rows[0]!.revision)
    const input: RepeatSaveInput = { workspaceId: f.version.workspaceId, workflowId: f.version.workflowId,
      commandId: randomUUID(), expectedRevision: revision, expectedWorkflowVersionId: f.version.id,
      executionSemanticsVersion: 3, repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id],
        entryNodeId: entry.id, exitNodeId: exit.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass',
        limitExit: { kind: 'branch_end' } }] } }
    return { f, principal, input, access, service: new RepeatAuthoringService(db.pool, new PostgresCommandCoordinator(db.pool)) }
  }
  async function unchanged(t: Awaited<ReturnType<typeof fixture>>) {
    const row = (await db.pool.query<{ current_version_id: string; revision: string; record: unknown }>(
      'select current_version_id,revision::text,record from workflows where id=$1', [t.f.version.workflowId])).rows[0]!
    expect(row.current_version_id).toBe(t.f.version.id)
    expect(Number(row.revision)).toBe(t.input.expectedRevision)
    expect(row.record).toEqual(t.f.version.definition)
    expect((await db.pool.query('select id from workflow_versions where workflow_id=$1', [t.f.version.workflowId])).rowCount).toBe(1)
    expect((await db.pool.query(`select command_id from management_command_receipts
      where principal_id=$1 and operation='repeat.save' and command_id=$2`, [t.principal.id, t.input.commandId])).rowCount).toBe(0)
  }
  it('does not publish, stop, or reserve a successful receipt while the affected Run is queued', async () => {
    const t = await fixture(true)
    await expect(t.service.save(t.principal, 'http', t.input)).rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED', status: 409 })
    await unchanged(t)
    const row = (await db.pool.query<{ execution_state: string; record: unknown }>(
      'select execution_state,record from runs where id=$1', [t.f.run.id])).rows[0]!
    expect(row.execution_state).toBe('queued')
    expect(row.record).toEqual(t.f.run)
    const audit = (await db.pool.query<{ outcome: string; details: { code: string } }>(
      `select outcome,details from management_audit where principal_id=$1 and action='repeat.save'`, [t.principal.id])).rows
    expect(audit.some((entry) => entry.outcome === 'failed' && entry.details.code === 'WORKFLOW_RUNS_UNSETTLED')).toBe(true)
  })
  it('rejects stale revision and immutable-version pins without consuming the command ID', async () => {
    const t = await fixture()
    await expect(t.service.save(t.principal, 'mcp', { ...t.input, expectedRevision: t.input.expectedRevision + 1 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(t.service.save(t.principal, 'mcp', { ...t.input, expectedWorkflowVersionId: 'other-version' }))
      .rejects.toMatchObject({ code: 'WORKFLOW_BASE_CONFLICT' })
    await unchanged(t)
  })
  it('revalidates live revocation inside the real command transaction', async () => {
    const t = await fixture()
    await t.access.revoke(t.principal.id)
    await expect(t.service.save(t.principal, 'mcp', t.input)).rejects.toBeTruthy()
    await unchanged(t)
  })
})
