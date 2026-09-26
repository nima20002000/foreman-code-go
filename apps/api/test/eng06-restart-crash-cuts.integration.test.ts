import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, NativeHarnessEventSchema, type HarnessExecution, type NativeHarnessEvent, type NativeSessionReference } from '@graphql/contracts'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { REPEAT_NATIVE_PENDING_MESSAGE, isSettlementPendingCheckpointError } from '../src/modules/interactions/repeatNativeEvidence.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import { readWorkflowCheckpoint } from '../src/modules/runs/repeatGraph.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { br1002Response } from './helpers/wave25Br1002OpenCodeRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { reserveFromExitedParent } from './helpers/eng06LaunchReservation.testSupport.js'

type Runtime = Awaited<ReturnType<typeof checkpointRuntimeFixture>>
type Ports = {
  reserveNativeLaunch?: (id: string, manager: NativeHarnessSessionManager) => void
  recoverNativeProcesses?: (id: string, signal: AbortSignal) => Promise<boolean>
}
const pending = () => new DomainError('REPEAT_CLEANUP_PENDING', REPEAT_NATIVE_PENDING_MESSAGE, 409)

async function executions(t: Runtime): Promise<HarnessExecution[]> {
  return (await t.db.pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1 order by created_at,id',
    [t.f.run.id])).rows.map((row) => HarnessExecutionSchema.parse(row.record))
}
async function effects(t: Runtime, kind: string) {
  return (await t.db.pool.query(`select entity_id,effect_digest,first_sequence::text from run_graph_effects
    where run_id=$1 and effect_kind=$2 order by entity_id`, [t.f.run.id, kind])).rows
}
async function originalProofs(t: Runtime, id: string) {
  return (await t.db.pool.query('select proof_id,source_digest,record from workflow_native_proofs where execution_id=$1 order by proof_id', [id])).rows
}
async function occurrenceCount(t: Runtime) {
  return Number((await t.db.pool.query<{ count: string }>('select count(*)::text as count from run_repeat_occurrences where run_id=$1',
    [t.f.run.id])).rows[0]!.count)
}

/** The real drive has finished at a persisted task error before this is called.
 * Model an abruptly dead API: its shutdown must NOT manufacture the missing
 * receipt. Only its old shutdown-close callback is suppressed. New composition
 * uses fresh managers/coordinator/capture channels and the same real DB/saver. */
async function coldRuntime(t: Runtime) {
  vi.spyOn(t.native, 'closeForRestart').mockResolvedValue(undefined)
  await t.engine.shutdown()
  return t.compose()
}

function terminalFrame(event: NativeHarnessEvent): NativeHarnessEvent {
  if (event.type !== 'turn.completed') return event
  const payload = event.payload as Record<string, unknown>
  return NativeHarnessEventSchema.parse({ ...event, payload: { ...payload, turn: { ...(payload.turn as Record<string, unknown>), status: 'failed' } } })
}

/** Change only the fixture's external provider transport. Both the ORIGINAL
 * terminal frame and terminal result agree; SQL/source/normalization/receipt
 * checks are unmocked. First-attempt failure does not seed a fake SQL result. */
function failEntryAtProvider(t: Runtime, allAttempts = false) {
  let first: string | undefined
  const failed = new Set<string>()
  const create = t.provider.createSession.bind(t.provider)
  vi.spyOn(t.provider, 'createSession').mockImplementation(async (input) => {
    const session = await create(input)
    if (input.kind !== 'operator' && input.request.workflowNodeId === t.f.version.entryNodeId
      && (allAttempts || !first)) {
      first ??= input.request.executionId
      failed.add(session.nativeSessionId)
    }
    return session
  })
  const start = t.provider.startTurn.bind(t.provider)
  vi.spyOn(t.provider, 'startTurn').mockImplementation(async function* (session, input) {
    for await (const event of start(session, input)) yield failed.has(session.nativeSessionId) ? terminalFrame(event) : event
  })
  const history = t.provider.history.bind(t.provider)
  vi.spyOn(t.provider, 'history').mockImplementation(async (session): Promise<NativeHistory> => {
    const source = await history(session)
    if (!failed.has(session.nativeSessionId) || !source.terminalResult) return source
    return { ...source, events: source.events.map(terminalFrame), terminalResult: {
      outcome: 'failed', error: { code: 'TRANSIENT_PROVIDER_FAILURE', message: 'Injected original provider failure', retryable: true },
    } }
  })
}

/** PostgreSQL, owner/G1 transactions, source captures, immutable first terminal,
 * checkpoint, approval ACK and acceptance services are real. Only the external
 * provider and filesystem qualification are synthetic, as in the base fixture. */
describe.skipIf(!postgresEnabled)('ENG06 exact restart crash cuts, semantics 3', () => {
  afterEach(() => vi.restoreAllMocks())

  describe.each(['sequential', 'repeat'] as const)('%s', (form) => {
    it.skipIf(process.platform !== 'linux').each(['stop', 'reconcile'] as const)(
      'settles %s after entered COMMIT but before the first process dispatch', async (finish) => {
        const fixture = makeCurrentWorkflowFixture(randomUUID(), form)
        const t = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [] })
        let restore: () => void = () => undefined
        try {
          const root = join(t.db.directory, 'launch-registry'), registry = new NativeProcessRegistry(root)
          const reservations: string[] = []
          const ports = t.native as unknown as Ports
          ports.reserveNativeLaunch = (id) => {
            reserveFromExitedParent(root, `execution:${id}`)
            reservations.push(id)
          }
          const authorize = RepeatRunRepository.prototype.authorizeNativeSubmission
          let cut: string | undefined
          const fault = vi.spyOn(RepeatRunRepository.prototype, 'authorizeNativeSubmission')
            .mockImplementation(async function (this: RepeatRunRepository, id, prepared) {
              expect(reservations).toContain(id) // Reservation must PRECEDE entered.
              await authorize.call(this, id, prepared)
              cut = id
              throw pending() // Known entered COMMIT, no native preflight/spawn.
            })
          restore = () => fault.mockRestore()
          await t.engine.start(t.f.run.id)
          expect(cut).toBeDefined()
          const original = (await executions(t)).find((item) => item.id === cut)!
          expect(original.state).toBe('starting')
          expect(original.nativeSessionId).toBeUndefined()
          expect((await t.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [cut])).rows)
            .toEqual([{ phase: 'entered' }])
          expect(t.provider.counts).toEqual({ sessions: 0, starts: 0, responses: 0, attaches: 0 })
          const launchReceipts = await effects(t, 'execution.launch'), occurrences = await occurrenceCount(t)
          expect(occurrences).toBe(form === 'repeat' ? 1 : 0)
          restore()
          const next = await coldRuntime(t)
          const recover = vi.fn((id: string, signal: AbortSignal) => registry.closeOwner(`execution:${id}`, signal))
          ;(next.native as unknown as Ports).recoverNativeProcesses = recover
          if (finish === 'stop') {
            await t.stop()
            expect(await next.engine.cancel(t.f.run.id)).toBe(true)
          } else await next.engine.start(t.f.run.id)
          const run = await next.runs.get(t.f.run.id)
          expect(run).toMatchObject({ executionState: 'completed', outcome: finish === 'stop' ? 'canceled' : 'failed' })
          expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
          const recovered = await next.runs.getExecution(original.id)
          expect(recovered).toMatchObject({ id: original.id, attempt: 1, input: original.input,
            agentConfigurationVersionId: original.agentConfigurationVersionId,
            workflowNodeId: original.workflowNodeId, runtimeDirectory: original.runtimeDirectory,
            state: 'completed', result: { outcome: finish === 'stop' ? 'canceled' : 'failed' } })
          expect((await t.db.pool.query('select generation from execution_native_recoveries where execution_id=$1', [cut])).rows).toHaveLength(1)
          expect(await effects(t, 'execution.launch')).toEqual(launchReceipts)
          expect(await occurrenceCount(t)).toBe(occurrences)
          expect(t.provider.counts).toEqual({ sessions: 0, starts: 0, responses: 0, attaches: 0 })
          expect(recover).toHaveBeenCalledTimes(1)
          await next.engine.start(t.f.run.id)
          expect(recover).toHaveBeenCalledTimes(1)
          expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
        } finally { restore(); await t.close() }
      }, 60_000)

    it.each(['success', 'approval', 'retry', 'retry-exhausted', 'stop'] as const)(
      'recovers a durable terminal before its closure receipt: %s', async (kind) => {
        const fixture = makeCurrentWorkflowFixture(randomUUID(), form)
        // One finite technical replacement in the same slot; business bounds
        // are unchanged and ordinary Runs never manufacture an occurrence.
        fixture.version.definition.executionPolicy!.maxNodeExecutions += 1
        const t = await checkpointRuntimeFixture(1, 1, { fixture,
          approvalNodeIds: kind === 'approval' ? [fixture.version.entryNodeId] : [],
          outputFor: (nodeId) => nodeId === fixture.version.definition.nodes[1]!.id && form === 'repeat'
            ? { routing: { outcome: 'pass' }, data: { node: nodeId } } : { node: nodeId },
        })
        let restore: () => void = () => undefined
        try {
          if (kind === 'retry' || kind === 'retry-exhausted') failEntryAtProvider(t, kind === 'retry-exhausted')
          // The external fixture manager really reports a close. Recovery is
          // allowed to attest ONLY that exact captured session, not any id.
          const closed = new Map<string, NativeSessionReference>()
          const close = t.provider.close.bind(t.provider)
          vi.spyOn(t.provider as NativeHarnessSessionManager, 'close').mockImplementation(async (...args) => {
            await close()
            closed.set(args[0].nativeSessionId, structuredClone(args[0]))
          })
          const record = PostgresWorkflowClosureStore.prototype.record
          let cut: HarnessExecution | undefined
          const fault = vi.spyOn(PostgresWorkflowClosureStore.prototype, 'record')
            .mockImplementation(async function (this: PostgresWorkflowClosureStore, execution, ...args) {
              if (execution.workflowNodeId === fixture.version.entryNodeId && execution.attempt === 1) {
                expect(execution.state).toBe('completed')
                expect(closed.get(execution.nativeSessionId!)).toEqual(args[0])
                cut = structuredClone(execution)
                throw pending() // AFTER original terminal and close, BEFORE receipt.
              }
              return record.call(this, execution, ...args)
            })
          restore = () => fault.mockRestore()
          await t.engine.start(t.f.run.id)
          if (kind === 'approval') {
            const interaction = (await t.pending())[0]!
            expect(interaction).toBeDefined()
            await t.service.respond({ kind: 'user', principal: t.principal }, br1002Response(interaction))
          }
          expect(cut).toBeDefined()
          const original = cut!
          expect(await t.runs.getExecution(original.id)).toEqual(original)
          expect((await t.db.pool.query('select closed_at from execution_native_closures where execution_id=$1', [original.id])).rows)
            .toEqual([{ closed_at: null }])
          expect(await new PostgresWorkflowClosureStore(t.db.pool).read(original)).toBeUndefined()
          expect((await originalProofs(t, original.id)).length).toBeGreaterThan(0)
          const proofs = await originalProofs(t, original.id), resumes = await t.receipts()
          const ackRows = (await t.db.pool.query('select interaction_id,state,approval_native_ack_id from interaction_graph_resumes where run_id=$1 order by interaction_id', [t.f.run.id])).rows
          if (kind === 'approval') {
            expect(resumes).toHaveLength(1)
            expect(ackRows).toHaveLength(1)
            expect(ackRows[0]).toMatchObject({ state: 'resumed', approval_native_ack_id: expect.any(String) })
          }
          expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
          const checkpoint = await readWorkflowCheckpoint(t.f.run.id, t.f.version, t.saver)
          expect(checkpoint.tasks.some((task) => isSettlementPendingCheckpointError(task.error))).toBe(true)
          restore()
          const next = await coldRuntime(t)
          const requestCleanup = vi.spyOn(next.runs, 'requestCleanup')
          const cancel = vi.spyOn(next.native, 'cancelRun')
          const physical = vi.fn(async (id: string, signal: AbortSignal) => {
            signal.throwIfAborted()
            const saved = await next.runs.getExecution(id)
            return id === original.id && saved?.nativeSessionId === original.nativeSessionId
              && closed.has(original.nativeSessionId!)
          })
          ;(next.native as unknown as Ports).recoverNativeProcesses = physical
          if (kind === 'stop') {
            await t.stop()
            expect(await next.engine.cancel(t.f.run.id)).toBe(true)
          } else await next.engine.start(t.f.run.id)
          expect(await next.runs.get(t.f.run.id)).toMatchObject({ executionState: 'completed',
            outcome: kind === 'stop' ? 'canceled' : kind === 'retry-exhausted' ? 'failed' : 'succeeded' })
          expect(await next.runs.getExecution(original.id)).toEqual(original)
          expect(await originalProofs(t, original.id)).toEqual(proofs)
          expect(await t.receipts()).toEqual(resumes)
          expect((await t.db.pool.query('select interaction_id,state,approval_native_ack_id from interaction_graph_resumes where run_id=$1 order by interaction_id', [t.f.run.id])).rows).toEqual(ackRows)
          expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
          expect(physical).toHaveBeenCalledTimes(1)
          expect(t.provider.counts.attaches).toBe(0)
          expect(t.provider.counts.responses).toBe(kind === 'approval' ? 1 : 0)
          if (kind !== 'stop' && kind !== 'retry-exhausted') {
            expect(requestCleanup).not.toHaveBeenCalled()
            expect(cancel).not.toHaveBeenCalled()
          }
          const all = await executions(t), attempts = all.filter((item) => item.workflowNodeId === original.workflowNodeId)
          expect(attempts.map((item) => item.attempt).sort()).toEqual(kind.startsWith('retry') ? [1, 2] : [1])
          expect(await occurrenceCount(t)).toBe(form === 'repeat' ? 1 : 0)
          if (kind.startsWith('retry')) {
            const second = attempts.find((item) => item.attempt === 2)!
            expect(second.id).not.toBe(original.id)
            expect(second.input).toEqual(original.input)
            expect(second.agentConfigurationVersionId).toBe(original.agentConfigurationVersionId)
            const owner = await next.runs.acquireOwnership(t.f.run.id, () => undefined)
            if (!owner) throw new Error('Test failed to acquire the settled Run owner')
            try {
              const store = await next.runs.repeat(owner)
              const firstSlot = await store.readExecution(original.id), nextSlot = await store.readExecution(second.id)
              expect(nextSlot.slotId).toBe(firstSlot.slotId)
              expect(nextSlot.ref).toEqual(firstSlot.ref)
              expect(nextSlot.inputDigest).toBe(firstSlot.inputDigest)
            } finally { await owner.release() }
          }
          if (kind !== 'stop' && !kind.startsWith('retry')) {
            expect((await effects(t, 'result.accept')).filter((row) => row.entity_id === original.id)).toHaveLength(1)
          }
          const counts = { ...t.provider.counts }, accepted = await effects(t, 'result.accept')
          await next.engine.start(t.f.run.id)
          expect(t.provider.counts).toEqual(counts)
          expect(await effects(t, 'result.accept')).toEqual(accepted)
          expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
        } finally { restore(); await t.close() }
      }, 60_000)
  })
})
