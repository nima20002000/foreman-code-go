import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { readRunCurrent } from '../src/modules/runs/liveSnapshot.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { currentPrincipal, currentRow, currentScope } from './helpers/feR2001Current.js'

describe('FE-R2-001 current read (SQL seam, not a database scale test)', () => {
  it('issues one scoped statement and never requests historical bodies or lifetime counts', async () => {
    const query = vi.fn(async () => ({ rows: [currentRow()] }))
    const value = await readRunCurrent({ query } as unknown as Pick<pg.Pool, 'query'>, currentScope)
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = (query.mock.calls as unknown as Array<[string, string[]]>)[0]!
    expect(params).toEqual([currentScope.workspaceId, currentScope.workflowId, currentScope.runId, currentScope.workflowVersionId])
    expect(sql).toMatch(/from run_activity a\s+where a.run_id=r.id order by a.sequence desc limit 1/)
    expect(sql).toMatch(/where e.run_id=r.id and e.workflow_node_id=node.value->>'id'\s+order by e.attempt desc limit 1/)
    expect(sql).not.toMatch(/count\s*\(|harness_native_events|a\.payload|review_jobs|offset\s/i)
    expect(value).toMatchObject({ history: 'not-included', settlement: 'unconfirmed', executions: [{ attempt: 3 }] })
    expect(value).not.toHaveProperty('activity')
    expect(value).not.toHaveProperty('liveActivity')
  })
  it('has fixed current DTO work for 10 versus 100000 observed activities (mock rows only)', async () => {
    const responses = []
    for (const head of ['10', '100000']) {
      const query = vi.fn(async () => ({ rows: [currentRow(head)] }))
      responses.push(await readRunCurrent({ query } as unknown as Pick<pg.Pool, 'query'>, currentScope))
      expect(query).toHaveBeenCalledTimes(1)
    }
    expect({ ...responses[0], asOfActivitySequence: 'same' }).toEqual({ ...responses[1], asOfActivitySequence: 'same' })
    expect(JSON.stringify(responses[1]).length - JSON.stringify(responses[0]).length).toBe(4)
  })
  it.each([false, true])('keeps completed outcome separate from cleanup=%s and unconfirmed settlement', async (cleanupPending) => {
    const row = currentRow('30', cleanupPending)
    row.run = { ...row.run, executionState: 'completed', outcome: 'succeeded', finishedAt: '2026-09-22T01:00:00.000Z' }
    const query = vi.fn(async () => ({ rows: [row] }))
    expect(await readRunCurrent({ query } as unknown as Pick<pg.Pool, 'query'>, currentScope))
      .toMatchObject({ run: { executionState: 'completed', outcome: 'succeeded' }, cleanupPending, settlement: 'unconfirmed' })
  })
  it('rejects v2, string semantics and unknown saved semantics instead of normalizing them', async () => {
    for (const marker of [2, 3, '1', null]) {
      const query = vi.fn(async () => ({ rows: [{ ...currentRow(), run_semantics: marker }] }))
      await expect(readRunCurrent({ query } as unknown as Pick<pg.Pool, 'query'>, currentScope))
        .rejects.toMatchObject({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
    }
  })
  it('rejects a conflicting authoritative version pin or definition semantics', async () => {
    for (const patch of [{ version_pin: 2 }, { definition_semantics: 2 }, { version_semantics: 2 }]) {
      const query = vi.fn(async () => ({ rows: [{ ...currentRow(), ...patch }] }))
      await expect(readRunCurrent({ query } as unknown as Pick<pg.Pool, 'query'>, currentScope))
        .rejects.toMatchObject({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
    }
  })
  it('rejects inconsistent persisted identity, definition and duplicate saved nodes', async () => {
    for (const patch of [{ version_id: 'wrong' }, { definition_id: 'wrong' }, { identities_valid: false },
      { nodes_valid: false }, { node_ids: ['duplicate', 'duplicate'] }, { run: { ...currentRow().run, workspaceId: 'wrong' } }]) {
      const query = vi.fn(async () => ({ rows: [{ ...currentRow(), ...patch }] }))
      await expect(readRunCurrent({ query } as unknown as Pick<pg.Pool, 'query'>, currentScope))
        .rejects.toMatchObject({ code: 'RUN_IDENTITY_INVALID' })
    }
  })
  it('authorizes before reading and preserves the same runs:read scope with no location privilege', async () => {
    const query = vi.fn(async () => ({ rows: [currentRow()] }))
    type Args = ConstructorParameters<typeof RunManagementService>
    const services = new RunManagementService({ query } as unknown as pg.Pool,
      {} as Args[1], {} as Args[2], {} as Args[3], {} as Args[4])
    await expect(services.current(currentPrincipal(false), currentScope)).rejects.toMatchObject({ status: 403 })
    expect(query).not.toHaveBeenCalled()
    await expect(services.current(currentPrincipal(), { ...currentScope, workflowId: 'foreign' })).rejects.toMatchObject({ status: 403 })
    expect(query).not.toHaveBeenCalled()
    const result = await services.current(currentPrincipal(), currentScope)
    expect(result.history).toBe('not-included')
    expect(result.run).not.toHaveProperty('executionLocation')
    expect(result.run).not.toHaveProperty('authorizationPrincipalId')
    expect(result.executions[0]).not.toHaveProperty('workingDirectory')
  })
  it('does not fall back to full details on a scope miss', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    type Args = ConstructorParameters<typeof RunManagementService>
    const getDetails = vi.fn()
    const service = new RunManagementService({ query } as unknown as pg.Pool, {} as Args[1],
      { getDetails } as unknown as Args[2], {} as Args[3], {} as Args[4])
    await expect(service.current(currentPrincipal(), currentScope)).rejects.toMatchObject({ status: 404 })
    expect(getDetails).not.toHaveBeenCalled()
  })
})
