import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution, type HarnessExecutionRequest } from '@graphql/contracts'
import { WAVE25_ADMISSION_ENABLED } from '@graphql/contracts/wave25'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { oneShotExecutionDriver, type OneShotRuntimeContext } from '../src/modules/runs/oneShotRuntime.js'
import { agent3Database, graphHead, ownedAgent3, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import {
  br2001Fixture, br2001Providers, br2001Terminal, br2001Text,
} from './helpers/wave25Br2001Choice.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

/** Actual one-shot driver -> provider-shaped coordinator port -> real owned SQL
 * update/accept/admit. Native transport, credentials, location qualification and
 * capacity are synthetic. This is NOT a real adapter/coordinator or full graph
 * run. Existing opt-in loopback-only DB safeguards are retained unchanged.
 */
describe.skipIf(!postgresEnabled)('BR2-001: driver and durable choice acceptance', () => {
  for (const provider of br2001Providers) {
    it.each(['pass', 'issues', 'invalid'] as const)(`${provider}: %s settles once with no fallback allocation`, async (outcome) => {
      const db = await agent3Database(); closes.push(db.close)
      const f = await seedAgent3(db.pool, db.directory, br2001Fixture(provider, randomUUID()))
      const { owner, store } = await ownedAgent3(db.pool, f); closes.push(() => owner.release())
      const { compare } = await graphParity(db.pool, f.scope, f.snapshot)
      await compare()
      await store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: f.createdAt })
      await compare()
      const text = outcome === 'invalid' ? `Review says: ${br2001Text('issues')}` : br2001Text(outcome, { source: provider })
      const rawResult = { outcome: 'succeeded', output: { text } }
      const readExecution = async (id: string) => {
        const rows = await db.pool.query<{ record: unknown }>('select record from harness_executions where id=$1', [id])
        return rows.rows[0] ? HarnessExecutionSchema.parse(rows.rows[0].record) : undefined
      }
      const native = { ensureObserve: vi.fn(async ({ candidate, request }: {
        candidate: HarnessExecution; request: HarnessExecutionRequest;
      }) => {
        expect(request.executionId).toBe(candidate.id)
        expect(request.configuration.harness.harness).toBe(provider)
        expect(request.initialPrompt).toContain('Allowed routing.outcome values: ["pass","issues"]')
        expect(request.initialPrompt).not.toContain(f.version.definition.edges[0]!.id)
        expect(request.input).toEqual(candidate.input)
        const terminal = br2001Terminal(candidate, provider, text)
        // Use the real exact-session binding and terminal writer. Do not seed
        // accepted=true, route resolutions, receipts or a pre-unwrapped result.
        await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(candidate.id, terminal.session)
        await store.updateExecution(terminal.execution)
        return { state: 'completed' as const, execution: terminal.execution, result: terminal.result }
      }) }
      const signal = new AbortController().signal
      const context = {
        run: f.run, version: f.version, owner, signal, native,
        runs: { oneShot: () => store, getExecution: readExecution,
          hasRequestedStop: async () => false },
        workflows: { getAgentConfiguration: async (id: string) => f.configurations.find((config) => config.id === id) },
        locations: { revalidateSnapshot: vi.fn(async () => undefined) },
        admission: { run: async (_runId: string, _signal: AbortSignal, work: () => Promise<void>) => work() },
        directory: (nodeId: string) => join(db.directory, nodeId),
      } as unknown as OneShotRuntimeContext
      const driver = oneShotExecutionDriver(context)
      const admitted = await store.admit(f.version.entryNodeId, () => driver.candidate(f.version.entryNodeId))
      if (admitted.kind !== 'admitted') throw new Error('Expected real Tester queue admission')
      await compare()
      // The actual driver's in-flight coalescing must not duplicate observation.
      await Promise.all([driver.observe(admitted.execution, signal), driver.observe(admitted.execution, signal)])
      expect(native.ensureObserve).toHaveBeenCalledTimes(1)
      const stored = (await readExecution(admitted.execution.id))!
      expect(stored.nativeSessionId).toBe(`${provider}-${admitted.execution.id}`)
      expect(stored.input).toEqual(admitted.execution.input)
      expect(stored.state).toBe('completed')
      expect(stored.result).toEqual(outcome === 'invalid' ? { outcome: 'failed', error: {
        code: 'WORKFLOW_CHOICE_RESULT_INVALID',
        message: 'The complete result did not satisfy the pinned bounded result contract.', retryable: false,
      } } : rawResult)
      await compare() // Terminal evidence is visible, but is not accepted routing yet.
      const beforeAcceptance = await graphHead(db.pool, f.run.id)
      if (outcome !== 'invalid') {
        // Force a real SQL failure in the later route write. The earlier
        // result.accept mutation must roll back with it, then retry safely.
        // These objects exist only in agent3Database's isolated test schema.
        await db.pool.query(`create function br2001_reject_resolution() returns trigger
          language plpgsql as $$ begin raise exception 'BR2-001 rollback injection'; end; $$`)
        await db.pool.query(`create trigger br2001_reject_resolution before insert on run_node_resolutions
          for each row execute function br2001_reject_resolution()`)
        try {
          await expect(store.acceptTerminal(stored.id)).rejects.toMatchObject({ code: 'GRAPH_INVALID_FACT' })
          expect(await graphHead(db.pool, f.run.id)).toBe(beforeAcceptance)
          expect((await db.pool.query('select accepted from harness_executions where id=$1', [stored.id])).rows)
            .toEqual([{ accepted: false }])
          expect((await db.pool.query('select 1 from run_node_resolutions where run_id=$1', [f.run.id])).rows).toEqual([])
          expect((await db.pool.query(`select 1 from run_graph_effects where run_id=$1
            and effect_kind in ('result.accept','route.resolve')`, [f.run.id])).rows).toEqual([])
          expect((await readExecution(stored.id))!.result).toEqual(rawResult)
          await compare()
        } finally {
          await db.pool.query('drop trigger br2001_reject_resolution on run_node_resolutions')
          await db.pool.query('drop function br2001_reject_resolution()')
        }
      }
      const resolution = await store.acceptTerminal(stored.id)
      const acceptedHead = await graphHead(db.pool, f.run.id)
      expect(BigInt(acceptedHead)).toBe(BigInt(beforeAcceptance) + 1n)
      await compare()
      expect(await store.acceptTerminal(stored.id)).toEqual(resolution)
      expect(await graphHead(db.pool, f.run.id)).toBe(acceptedHead)
      expect((await store.readResolutions()).get(stored.workflowNodeId)).toEqual(resolution)
      await compare()
      expect(resolution.resolution).toBe(outcome === 'invalid' ? 'failed' : 'succeeded')
      expect(resolution.outcome).toBe(outcome === 'invalid' ? undefined : outcome)
      expect(resolution.branchEnded).toBe(outcome === 'pass')
      expect(resolution.selectedRelationshipIds).toEqual(outcome === 'issues' ? [f.version.definition.edges[0]!.id] : [])
      expect(resolution.acceptedResultDigest).toBe(outcome === 'invalid' ? undefined : graphSourceDigest(rawResult))

      const fixer = f.version.definition.nodes[1]!.id
      const candidate = vi.fn(() => driver.candidate(fixer))
      const first = await store.admit(fixer, candidate)
      const admittedHead = await graphHead(db.pool, f.run.id)
      await compare()
      const replay = await store.admit(fixer, candidate)
      expect(await graphHead(db.pool, f.run.id)).toBe(admittedHead)
      await compare()
      const rows = await db.pool.query<{ record: unknown }>(
        'select record from harness_executions where run_id=$1 and workflow_node_id=$2', [f.run.id, fixer])
      if (outcome === 'issues') {
        expect(candidate).toHaveBeenCalledTimes(1)
        expect(first.kind).toBe('admitted')
        if (first.kind !== 'admitted') throw new Error('Expected exactly one Fixer allocation')
        expect(replay).toEqual({ kind: 'admitted', execution: first.execution, reused: true })
        expect(rows.rows).toHaveLength(1)
        const receiving = HarnessExecutionSchema.parse(rows.rows[0]!.record)
        expect(receiving.input).toEqual({ executionSemanticsVersion: 2, runInput: f.run.input, predecessors: [{
          relationshipId: f.version.definition.edges[0]!.id, senderNodeId: stored.workflowNodeId,
          senderExecutionId: stored.id, acceptedResult: rawResult,
        }] })
        expect(receiving.nativeSessionId).toBeUndefined()
        expect(receiving.runtimeDirectory).toBeUndefined()
      } else {
        expect(candidate).not.toHaveBeenCalled()
        expect(first).toMatchObject({ kind: 'resolved', resolution: { resolution: 'skipped' } })
        expect(replay).toEqual(first)
        expect(rows.rows).toHaveLength(0)
      }
      const effects = await db.pool.query<{ effect_kind: string; count: number }>(
        `select effect_kind, count(*)::int as count from run_graph_effects
         where run_id=$1 and ((effect_kind='result.accept' and entity_id=$2)
           or (effect_kind='route.resolve' and entity_id=$3)) group by effect_kind`,
        [f.run.id, stored.id, stored.workflowNodeId])
      expect(Object.fromEntries(effects.rows.map((row) => [row.effect_kind, row.count]))).toEqual(
        outcome === 'invalid' ? { 'route.resolve': 1 } : { 'result.accept': 1, 'route.resolve': 1 })
      const acceptance = await db.pool.query<{ accepted: boolean }>(
        'select accepted from harness_executions where id=$1', [stored.id])
      expect(acceptance.rows[0]!.accepted).toBe(outcome !== 'invalid')
      expect((await readExecution(stored.id))!.result).toEqual(stored.result)
      expect(native.ensureObserve).toHaveBeenCalledTimes(1)
      expect(WAVE25_ADMISSION_ENABLED).toBe(false)
    }, 60000)
  }
})
