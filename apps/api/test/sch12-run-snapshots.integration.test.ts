import { randomUUID } from 'node:crypto'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { PostgresScheduleDispatcher } from '../src/modules/schedules/postgresDispatcher.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import {
  historicalFixture, historicalRows, openHistoricalApi, qualifyLocation, readSnapshot,
  runA, saveWithoutY, snapshotPath, startSaved, targetFor, terminal, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'

afterEach(() => vi.restoreAllMocks())

// Intentionally no vi.mock(migrations): the pinned base registers SCH-05 itself.
// Product regressions remain ordinary failing assertions, never it.fails/skip.
describe.skipIf(!postgresEnabled)('SCH-12 historical Run snapshots / PostgreSQL / HTTP / MCP', () => {
  it('[SCH-12-S01] A retains removed Y, edges and old geometry; B captures the saved removal/move; fresh services read both', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      api = await openHistoricalApi(f)
      const x = f.f.version.definition.nodes[0]!, y = f.f.version.definition.nodes[1]!
      const before = await readSnapshot(api, targetFor(f))
      if (before.kind !== 'available') throw new Error('New Run A must have a persisted snapshot')
      expect(before.nodes).toHaveLength(2)
      expect(before.nodes.find((node) => node.id === x.id)).toMatchObject({ name: 'Agent X',
        position: { x: -48.5, y: 120 }, size: { width: 256, height: 144 } })
      expect(before.nodes.find((node) => node.id === y.id)).toMatchObject({ name: 'Agent Y', agentId: y.agentId,
        agentConfigurationVersionId: f.f.version.agentConfigurationVersionIds[y.agentId],
        position: { x: 415, y: 276.25 }, size: { width: 312, height: 160 } })
      expect(before.edges).toEqual(f.f.version.definition.edges)
      expect(before.edges).not.toHaveLength(0)
      const old = await historicalRows(f.db.pool, [f.f.run.id])
      expect(old.sessions).not.toHaveLength(0)
      expect(old.snapshots).toHaveLength(1)
      expect(old.snapshots[0]!.record).toEqual(before)

      const { saved } = await saveWithoutY(f)
      expect(saved.version.id).not.toBe(f.f.version.id)
      expect(saved.version.definition.nodes.some((node) => node.id === y.id)).toBe(false)
      expect(saved.version.definition.edges).toHaveLength(0)
      expect(await readSnapshot(api, targetFor(f))).toEqual(before)
      // Removal means the typed Board deletion above plus the supported archive.
      // Hard-deleting a historically pinned Agent is restricted by existing FKs;
      // never disable those constraints to manufacture a passing history test.
      await f.db.pool.query("update agents set archived_at=now(), record=jsonb_set(record,'{name}','\"Current renamed Y\"') where id=$1", [y.agentId])
      await expect(f.db.pool.query('delete from agents where id=$1', [y.agentId])).rejects.toMatchObject({ code: '23503' })
      expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(old)

      const b = await startSaved(f, agentWorkflowVersion(saved.version))
      const after = await readSnapshot(api, targetFor(f, b.id))
      if (after.kind !== 'available') throw new Error('Run B must have its own persisted snapshot')
      expect(after.workflowVersionId).toBe(saved.version.id)
      expect(after.nodes).toHaveLength(1)
      expect(after.nodes[0]).toMatchObject({ id: x.id, name: 'Agent X', position: { x: 909, y: -33 }, size: { width: 480, height: 144 } })
      expect(after.nodes.some((node) => {
        if (node.kind === 'job') throw new Error('Historical Agent snapshot fixture requires Agent nodes')
        return node.id === y.id || node.agentId === y.agentId
      })).toBe(false)
      expect(after.edges).toHaveLength(0)
      expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(old)
      const retained = await historicalRows(f.db.pool, [f.f.run.id, b.id])

      const previousPool = api.pool, previousChat = api.chat, previousHistory = api.services.runs.history
      await api.close()
      api = await openHistoricalApi(f)
      expect(api.pool).not.toBe(previousPool)
      expect(api.chat).not.toBe(previousChat)
      expect(api.services.runs.history).not.toBe(previousHistory)
      expect(await readSnapshot(api, targetFor(f))).toEqual(before)
      expect(await readSnapshot(api, targetFor(f, b.id))).toEqual(after)
      expect(api.native.size).toBe(0)
      expect(await historicalRows(api.pool, [f.f.run.id, b.id])).toEqual(retained)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)

  it('[SCH-12-S02] real manual Start and guarded scheduled admission persist the same complete snapshot shape', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      await qualifyLocation(f)
      const manual = await startSaved(f)
      api = await openHistoricalApi(f)
      const manualSnapshot = await readSnapshot(api, targetFor(f, manual.id))
      if (manualSnapshot.kind !== 'available') throw new Error('Manual admission must capture the Board')
      const beforeManual = await historicalRows(f.db.pool, [manual.id])

      // Only recurrence time is injected. Authorization, SQL locks, location
      // evidence, the common G1 publisher and occurrence commit remain real.
      let now = new Date()
      const schedules = new WorkflowScheduleService(f.db.pool, f.commands, () => now)
      const { workspaceId, workflowId } = f.f.scope
      const slot = (await schedules.save(f.writer.principal, 'http', { workspaceId, workflowId,
        commandId: randomUUID(), expectedRevision: 0, schedule: { mode: 'interval', every: 1, unit: 'minute',
          anchorAt: now.toISOString(), timezone: 'UTC', enabled: true, policy: 'latest_saved' },
      })).value
      expect(slot.nextOccurrenceAt).not.toBeNull()
      now = new Date(slot.nextOccurrenceAt!)
      const dispatcher = new PostgresScheduleDispatcher(f.db.pool, async (principal, input, schedule) => {
        await admitRepeatRun(f.db.pool, f.locations, principal, 'schedule', input, repeatStartPublication, { schedule })
      }, () => now)
      await dispatcher.dispatch(slot)
      const facts = (await schedules.recentOccurrences(f.writer.principal, { workspaceId, workflowId })).items
      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ status: 'accepted', workflowVersionId: f.f.version.id })
      if (facts[0]?.status !== 'accepted') throw new Error('Scheduled occurrence must be accepted')
      const scheduledId = facts[0]!.runId
      if (!scheduledId) throw new Error('Accepted scheduled occurrence must identify its exact Run')
      expect(scheduledId).not.toBe(manual.id)
      const scheduledSnapshot = await readSnapshot(api, targetFor(f, scheduledId))
      if (scheduledSnapshot.kind !== 'available') throw new Error('Scheduled admission must capture the Board')
      // Compare every field: only Run identity and admission time legitimately
      // differ. Do not reduce parity to node counts or a handful of shared keys.
      expect({ ...scheduledSnapshot, runId: manualSnapshot.runId, capturedAt: manualSnapshot.capturedAt }).toEqual(manualSnapshot)
      const triggers = (await f.db.pool.query<{ run_id: string; admission_trigger: string }>(
        'select run_id,admission_trigger from run_board_snapshots where run_id=any($1::text[])', [[manual.id, scheduledId]])).rows
      expect(triggers).toEqual(expect.arrayContaining([
        { run_id: manual.id, admission_trigger: 'manual' }, { run_id: scheduledId, admission_trigger: 'schedule' },
      ]))
      expect(triggers).toHaveLength(2)
      const durable = (await f.db.pool.query('select * from run_board_snapshots where run_id=$1', [scheduledId])).rows
      // A stale scan in a fresh dispatcher cannot replace the capture or create a Run.
      await new PostgresScheduleDispatcher(f.db.pool, async (principal, input, schedule) => {
        await admitRepeatRun(f.db.pool, f.locations, principal, 'schedule', input, repeatStartPublication, { schedule })
      }, () => now).dispatch(slot)
      expect((await schedules.recentOccurrences(f.writer.principal, { workspaceId, workflowId })).items).toEqual(facts)
      expect((await f.db.pool.query('select * from run_board_snapshots where run_id=$1', [scheduledId])).rows).toEqual(durable)
      expect(await historicalRows(f.db.pool, [manual.id])).toEqual(beforeManual)
      // The admission callback above deliberately does not impersonate the native
      // runtime. Dispatch this committed ID once through the real fixture engine.
      await f.engine.start(scheduledId); await terminal(f, scheduledId)
      expect(await readSnapshot(api, targetFor(f, scheduledId))).toEqual(scheduledSnapshot)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)

  it('[SCH-12-S03] forged and physically foreign Run tuples are denied over both transports without changing history', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      // A genuinely persisted foreign workspace/workflow/Run in the SAME schema,
      // not an ID from another isolated database that merely looks nonexistent.
      const foreign = await seedAgent3(f.db.pool, f.db.directory, makeCurrentWorkflowFixture(randomUUID(), 'single'))
      api = await openHistoricalApi(f)
      const reader = await f.access.issue({ name: 'SCH-12 snapshot reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId] } }] })
      const client = await api.connect(reader.token)
      await readSnapshot(api, targetFor(f), reader.token, client)
      const allowed = targetFor(f)
      const foreignTarget = { workspaceId: foreign.scope.workspaceId, workflowId: foreign.scope.workflowId, runId: foreign.run.id }
      // Establish that foreign data exists and is accessible to an authorized caller.
      expect((await readSnapshot(api, foreignTarget)).kind).toBe('available')
      const before = await historicalRows(f.db.pool, [allowed.runId, foreign.run.id])
      for (const [target, status] of [
        [{ ...allowed, runId: `forged-${randomUUID()}` }, 404],
        [{ ...allowed, runId: foreign.run.id }, 404],
        [foreignTarget, 403],
        [{ ...allowed, workflowId: foreign.scope.workflowId }, 403],
      ] as const) {
        const http = await api.app.inject({ method: 'GET', url: snapshotPath(target), headers: { authorization: `Bearer ${reader.token}` } })
        expect(http.statusCode, http.body).toBe(status)
        const denied = await client.callTool({ name: 'run_board_snapshot_get', arguments: { ...target } })
        expect(denied.isError).toBe(true)
        expect(denied.structuredContent).toBeUndefined()
        expect(JSON.stringify(denied)).toContain(http.json<{ error: { code: string } }>().error.code)
        expect(http.json()).not.toHaveProperty('snapshot')
      }
      const unauthenticated = await api.app.inject({ method: 'GET', url: snapshotPath(allowed) })
      expect(unauthenticated.statusCode).toBe(401)
      expect(await historicalRows(f.db.pool, [allowed.runId, foreign.run.id])).toEqual(before)
      expect(api.native.size).toBe(0)
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)
})
