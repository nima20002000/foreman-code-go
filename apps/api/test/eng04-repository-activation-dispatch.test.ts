import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { PostgresRunRepository, runRepositorySemantics } from '../src/modules/runs/postgres.js'
import type { RepeatRepositoryActivation } from '../src/modules/runs/port.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { startFixture } from './eng04-start-fixtures.js'

// Dispatch/identity tests, NOT PostgreSQL or a native authority implementation.
// Snapshot delegation is explicitly spied below; the PG suite tests actual reads.
function fixture() {
  const f = startFixture(), calls: string[] = []
  const state = { record: f.run as unknown, physicalSemantics: 3, lost: false,
    executionRunId: f.run.id }
  const query = vi.fn(async (text: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    calls.push(text)
    if (text.startsWith('select run_id from harness_executions')) return { rows: [{ run_id: state.executionRunId }], rowCount: 1 }
    if (text.includes('v.execution_semantics_version from runs r')) return { rows: [
      { record: state.record, version: { executionSemanticsVersion: state.physicalSemantics }, execution_semantics_version: state.physicalSemantics },
    ], rowCount: 1 }
    if (text.startsWith('select record from runs where id =')) return { rows: [{ record: state.record }], rowCount: 1 }
    throw new Error(`Unmodelled SQL: ${text}`)
  })
  const pool = { query, connect: vi.fn(() => { throw new Error('unexpected pool checkout') }) } as unknown as pg.Pool
  const unavailable = async (): Promise<never> => { throw new Error('unexercised dependency; not native evidence') }
  const workflows = { getCurrentVersion: unavailable } as unknown as PostgresWorkflowRepository
  const locations = { revalidateRunAuthorization: unavailable } as unknown as WorkspaceLocationService
  const owner = { runId: f.run.id, client: { query }, oneShotConnection: () => ({ unusable: false }), assertOwned() {
    if (state.lost) throw new Error('owner lost')
  } } as unknown as RunOwnership
  const activation: RepeatRepositoryActivation = { runtimeRoot: '/synthetic/runtime', services: {
    assertNativeBoundaryLocked: unavailable, assertNativeUpdateLocked: unavailable,
    assertSettlementLocked: unavailable, allowTechnicalRetryLocked: unavailable, completeRunLocked: unavailable,
  } }
  const execution = HarnessExecutionSchema.parse({ id: 'repository-dispatch-execution', runId: f.run.id,
    workflowNodeId: f.version.entryNodeId, agentId: f.version.definition.nodes[0]!.agentId,
    agentConfigurationVersionId: f.version.agentConfigurationVersionIds[f.version.definition.nodes[0]!.agentId],
    attempt: 1, state: 'queued', input: {}, createdAt: f.run.createdAt })
  const repository = new PostgresRunRepository(pool, workflows, locations)
  return { f, state, calls, query, pool, owner, activation, execution, repository, workflows, locations }
}
afterEach(() => vi.restoreAllMocks())

describe('ENG04 central repository strict dispatch', () => {
  it.each([1, 2, 3] as const)('retains literal semantics %i', (version) => {
    expect(runRepositorySemantics({ executionSemanticsVersion: version })).toBe(version)
  })
  it('only missing tags are legacy absence', () => expect(runRepositorySemantics({})).toBe(1))
  it.each([null, undefined, '1', '2', '3', 0, 4, true, {}, []])('rejects explicit unknown tag %j', (tag) => {
    expect(() => runRepositorySemantics({ executionSemanticsVersion: tag })).toThrowError(expect.objectContaining({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' }))
  })
  it.each([null, undefined, [], '3'])('rejects non-record %j', (record) => {
    expect(() => runRepositorySemantics(record)).toThrow()
  })
  it('never returns false for v3 at the old binary boundary', async () => {
    const t = fixture()
    await expect(t.repository.executionSemantics(t.f.run.id)).resolves.toBe(3)
    await expect(t.repository.isOneShot(t.f.run.id)).rejects.toMatchObject({ code: 'REPEAT_DISPATCH_REQUIRED' })
    expect(t.pool.connect).not.toHaveBeenCalled()
  })
  it.each([1, 2] as const)('preserves the %i binary result', async (semantics) => {
    const t = fixture(); t.state.record = { id: t.f.run.id, ...(semantics === 2 ? { executionSemanticsVersion: 2 } : {}) }
    t.state.physicalSemantics = semantics
    await expect(t.repository.isOneShot(t.f.run.id)).resolves.toBe(semantics === 2)
  })
  it('rejects a missing JSON tag backed by a v3 physical version', async () => {
    const t = fixture(); t.state.record = { id: t.f.run.id }
    await expect(t.repository.isOneShot(t.f.run.id)).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
  })
  it('does not retarget get to the Run ID inside a corrupt record', async () => {
    const t = fixture(); t.state.record = { ...t.f.run, id: 'another-run' }
    const read = vi.spyOn(t.repository, 'getRepeatSnapshot')
    await expect(t.repository.get(t.f.run.id)).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
    expect(read).not.toHaveBeenCalled()
  })
  it('uses the exact accepted reader with the same owner rather than a legacy schema', async () => {
    const t = fixture()
    const read = vi.spyOn(t.repository, 'getRepeatSnapshot').mockResolvedValue({ run: t.f.run, version: t.f.version,
      configurations: t.f.f.configurations, stopRequested: false, cleanupPending: false })
    await expect(t.repository.get(t.f.run.id, t.owner)).resolves.toEqual(t.f.run)
    expect(read).toHaveBeenCalledExactlyOnceWith(t.f.run.id, t.owner)
    expect(t.pool.connect).not.toHaveBeenCalled()
  })
  it('requires real host composition and never invents native proof', async () => {
    const t = fixture()
    await expect(t.repository.updateExecution(t.execution, t.owner)).rejects.toMatchObject({ code: 'REPEAT_NATIVE_HOST_REQUIRED' })
    expect(t.repository.consumeRepeatLaunch(t.execution.id, t.owner)).toBe(false)
    expect(t.calls.every((sql) => sql.startsWith('select'))).toBe(true)
  })
  it('one factory owns one store per owner and cannot transfer a permit to a successor owner', async () => {
    const t = fixture(), repository = new PostgresRunRepository(t.pool, t.workflows, t.locations, t.activation)
    vi.spyOn(repository, 'getRepeatSnapshot').mockResolvedValue({ run: t.f.run, version: t.f.version,
      configurations: t.f.f.configurations, stopRequested: false, cleanupPending: false })
    const first = await repository.repeat(t.owner)
    expect(await repository.repeat(t.owner)).toBe(first)
    const successor = { ...t.owner } as RunOwnership
    expect(await repository.repeat(successor)).not.toBe(first)
    expect(repository.consumeRepeatLaunch(t.execution.id, successor)).toBe(false)
    expect(repository.repeatRepositoryFactory()).toBe(repository.repeatRepositoryFactory())
    expect(t.pool.connect).not.toHaveBeenCalled()
  })
  it('requires the current owner before a v3 mutation', async () => {
    const t = fixture()
    await expect(t.repository.updateExecution(t.execution)).rejects.toMatchObject({ code: 'RUN_OWNERSHIP_REQUIRED' })
    t.state.lost = true
    await expect(t.repository.updateExecution(t.execution, t.owner)).rejects.toThrow('owner lost')
    expect(() => t.repository.consumeRepeatLaunch(t.execution.id, t.owner)).toThrow('owner lost')
  })
  it('does not classify an existing v3 execution using a caller-supplied legacy Run ID', async () => {
    const t = fixture()
    await expect(t.repository.updateExecution({ ...t.execution, runId: 'legacy-run' }))
      .rejects.toMatchObject({ code: 'EXECUTION_OCCURRENCE_CONFLICT' })
    expect(t.calls).toEqual(['select run_id from harness_executions where id=$1'])
  })
  it.each(['requestStop', 'requestCleanup', 'finishCleanup'] as const)('%s remains closed rather than calling legacy SQL', async (method) => {
    const t = fixture()
    const result = method === 'finishCleanup' ? t.repository.finishCleanup(t.f.run.id, false) : t.repository[method](t.f.run.id)
    await expect(result).rejects.toMatchObject({ code: 'REPEAT_LIFECYCLE_PUBLICATION_REQUIRED' })
    expect(t.calls.every((sql) => sql.startsWith('select'))).toBe(true)
  })
  it('does not insert a repeat execution through either legacy admission method', async () => {
    const t = fixture()
    await expect(t.repository.createExecution(t.execution, t.owner)).rejects.toMatchObject({ code: 'EXECUTION_ADMISSION_REQUIRED' })
    await expect(t.repository.ensureExecution(t.execution)).rejects.toMatchObject({ code: 'RUN_OWNERSHIP_REQUIRED' })
    expect(t.calls.every((sql) => sql.startsWith('select'))).toBe(true)
  })
  it('freezes legacy creation identity before asynchronous classification', async () => {
    const t = fixture(), original = structuredClone(t.execution), writes: unknown[] = []
    const legacy = structuredClone(t.f.run) as Record<string, unknown>; delete legacy.executionSemanticsVersion
    t.query.mockImplementation(async (text: string, ...args: unknown[]) => {
      t.calls.push(text)
      if (text.includes('v.execution_semantics_version from runs r')) {
        t.execution.id = 'forged-v3-execution'; t.execution.runId = 'forged-v3-run'
        return { rows: [{ record: legacy, version: {}, execution_semantics_version: 1 }], rowCount: 1 }
      }
      if (text.includes('insert into harness_executions')) {
        writes.push(JSON.parse((args[0] as unknown[])[5] as string))
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('select run_id from harness_executions')) return { rows: [{ run_id: original.runId }], rowCount: 1 }
      if (text.includes('insert into run_activity')) return { rows: [{ sequence: '1' }], rowCount: 1 }
      throw new Error(`Unmodelled snapshot SQL: ${text}`)
    })
    await t.repository.createExecution(t.execution)
    expect(writes).toEqual([original])
  })
  it('rejects cross-Run raw activity before writing through a legacy Run', async () => {
    const t = fixture(), legacy = structuredClone(t.f.run) as Record<string, unknown>
    delete legacy.executionSemanticsVersion; t.state.record = legacy; t.state.physicalSemantics = 1
    t.state.executionRunId = 'another-v3-run'
    await expect(t.repository.recordActivity(t.f.run.id, 'harness', 'node_state_changed', {}, t.execution.id))
      .rejects.toMatchObject({ code: 'EXECUTION_OCCURRENCE_CONFLICT' })
    expect(t.calls.every((sql) => sql.startsWith('select'))).toBe(true)
  })
  it('a v3 version cannot be requested under another immutable pin', async () => {
    const t = fixture()
    vi.spyOn(t.repository, 'getRepeatSnapshot').mockResolvedValue({ run: t.f.run, version: t.f.version,
      configurations: t.f.f.configurations, stopRequested: false, cleanupPending: false })
    await expect(t.repository.getRepeatVersion(t.f.run.id, 'different-version', t.owner)).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
  })
})
