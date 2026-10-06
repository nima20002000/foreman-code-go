import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { deferred, postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { approvalFaultFixture, approvalResponse, type ApprovalFaultFixture, type FaultForm } from './helpers/eng06ApprovalFaults.js'

const fixtures: ApprovalFaultFixture[] = []
afterEach(async () => {
  const failures: unknown[] = []
  try {
    while (fixtures.length) {
      try { await fixtures.pop()!.close() } catch (error) { failures.push(error) }
    }
  } finally { vi.restoreAllMocks() }
  if (failures.length) throw new AggregateError(failures, 'ENG06 test-provider shutdown did not settle')
})
async function setup(form: FaultForm, options: { approvals?: boolean } = {}) {
  const t = await approvalFaultFixture(form, options)
  fixtures.push(t)
  return t
}
async function startWaiting(t: ApprovalFaultFixture) {
  await t.runtime.engine.start(t.runId)
  expect(await t.runtime.runs.get(t.runId)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
  await t.assertShape(1)
  const interaction = await t.onePending()
  expect(interaction.executionId).toBeDefined()
  expect((await t.compare()).state.run.pendingInteractionCount).toBe(1)
  return interaction
}
async function loseGraphAcknowledgement(t: ApprovalFaultFixture) {
  const pending = await startWaiting(t)
  // Fail AFTER positive delivery, before the actual checkpoint consumer. This
  // injects a lost callback, not a manufactured delivery or graph.resume receipt.
  const interrupted = vi.spyOn(t.runtime.engine, 'resumeInteraction').mockRejectedValueOnce(
    new DomainError('ENGINE_RESTART', 'Injected loss of the API graph-resume callback.', 409))
  try {
    const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
    expect(response.interaction).toMatchObject({ id: pending.id, status: 'delivered', deliveryState: 'delivered' })
    expect(interrupted).toHaveBeenCalledTimes(1)
    expect(await t.f.receipts()).toHaveLength(0)
    expect((await t.runtime.runs.get(t.runId))?.executionState).toBe('waiting')
    expect(t.f.provider.counts.responses).toBe(1)
    await t.assertNoNativeAcknowledgement(pending.id)
    return { pending, delivered: response.interaction }
  } finally { interrupted.mockRestore() }
}
async function assertInterrupted(t: ApprovalFaultFixture, executionId: string) {
  await t.settled('failed')
  expect(await t.runtime.runs.getExecution(executionId)).toMatchObject({ state: 'completed',
    result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED' } } })
  const recovered = await t.recoveryRows()
  expect(recovered).toHaveLength(1)
  expect(recovered[0]).toMatchObject({ execution_id: executionId,
    execution_identity: { id: executionId, runId: t.runId } })
  expect(recovered[0]!.reference?.nativeSessionId).toBe((await t.runtime.runs.getExecution(executionId))?.nativeSessionId)
  expect(recovered[0]!.owner_id).toMatch(/^\d+$/)
  expect(recovered[0]!.owner_fence).toMatch(/^\d+$/)
  expect(t.faults.processes.isClosed(executionId)).toBe(true)
  expect(t.faults.processes.recoveredExecutions).toEqual([executionId])
  expect(t.f.provider.counts.attaches).toBe(0)
  expect(new Set(t.f.provider.startedExecutions).size).toBe(t.f.provider.startedExecutions.length)
  await t.assertShape(1)
}
async function assertPredecessorsUnchanged(t: ApprovalFaultFixture, before: Awaited<ReturnType<typeof readCurrentExecutions>>) {
  for (const execution of before.filter((item) => item.state === 'completed')) {
    expect(await t.runtime.runs.getExecution(execution.id)).toEqual(execution)
  }
}

// d32a361: a cold nonterminal requester is interrupted BEFORE checkpoint consume;
// retained external history is not permission to reattach/replay. A resident
// requester still supports exact-history reconciliation. Both paths keep G1,
// owner/session/generation checks, real SQL receipts and the complete graph reducer.
for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`ENG06-C ${form}: approval / native ACK / recovery / graph parity`, () => {
    it('recovers a lost delivery observation on the original resident session exactly once', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      t.faults.hideResponseEvidence = true
      const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
      expect(response.interaction.deliveryState).toBe('uncertain')
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      t.faults.hideResponseEvidence = false
      const recovered = await t.runtime.service.reconcile(response.interaction)
      expect(recovered.deliveryState).toBe('delivered')
      expect(await t.f.receipts()).toHaveLength(1)
      expect(t.f.provider.counts).toMatchObject({ responses: 1, attaches: 0 })
      expect((await t.runtime.runs.getExecution(pending.executionId!))?.result?.outcome).toBe('succeeded')
      const ack = (await t.f.db.pool.query<{ approval_native_ack_id: string; approval_native_ack_record: unknown }>(
        'select approval_native_ack_id,approval_native_ack_record from interaction_graph_resumes where interaction_id=$1', [pending.id])).rows
      expect(ack).toHaveLength(1)
      expect(ack[0]!.approval_native_ack_id).toEqual(expect.any(String))
      expect(ack[0]!.approval_native_ack_record).not.toBeNull()
      await t.compare(); await t.finishApprovals()
      expect(t.f.provider.counts).toMatchObject({ starts: form === 'repeat' ? 4 : 2, responses: form === 'repeat' ? 2 : 1 })
      expect(await t.recoveryRows()).toHaveLength(0)
    }, 90000)

    it('keeps a sent-but-unacknowledged response uncertain after restart, then interrupts without cold attach or resend', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      const before = await readCurrentExecutions(t.runtime.runs, t.runId)
      t.faults.hideResponseEvidence = true
      const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
      expect(response.interaction.deliveryState).toBe('uncertain')
      expect(await t.f.receipts()).toHaveLength(0)
      await t.compare(); await t.restart()
      const detached = await t.closureRows()
      t.faults.hideResponseEvidence = false
      // The provider has retained history, but the NEW coordinator must not
      // attach it. No persisted original delivery evidence exists in this fault.
      const observed = await t.runtime.service.reconcile(response.interaction)
      expect(observed).toMatchObject({ id: pending.id, deliveryState: 'uncertain' })
      expect(t.f.provider.counts.attaches).toBe(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      await t.recoverUntilSettled(); await assertInterrupted(t, pending.executionId!)
      expect(await t.closureRows()).toEqual(detached)
      await assertPredecessorsUnchanged(t, before)
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      expect(t.faults.responseWrites).toEqual([{ sessionId: pending.nativeSessionId,
        requestId: pending.nativeRequestId, optionId: approvalResponse(pending).optionId }])
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1 })
    }, 90000)

    it('retains proven delivery but does not consume a lost graph acknowledgement for a cold requester', async () => {
      const t = await setup(form), { pending, delivered } = await loseGraphAcknowledgement(t)
      const before = await readCurrentExecutions(t.runtime.runs, t.runId)
      await t.restart()
      const detached = await t.closureRows()
      await t.runtime.engine.resume(t.runId)
      await assertInterrupted(t, pending.executionId!)
      expect(await t.runtime.repository.get(pending.id)).toMatchObject({ deliveryState: 'delivered',
        nativeSessionId: delivered.nativeSessionId, selectedOptionId: delivered.selectedOptionId })
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      await assertPredecessorsUnchanged(t, before)
      expect(await t.closureRows()).toEqual(detached)
      const receipts = await t.recoveryRows()
      await t.runtime.engine.resumeInteraction(delivered)
      expect(await t.recoveryRows()).toEqual(receipts)
      await expect(t.runtime.service.respond(t.responder, approvalResponse(pending)))
        .rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      await t.settled('failed')
    }, 90000)

    it('preserves the consumed graph receipt without manufacturing a native ACK after restart', async () => {
      const t = await setup(form), pending = await startWaiting(t), gate = t.faults.holdWorkerAcknowledgement()
      const response = t.runtime.service.respond(t.responder, approvalResponse(pending))
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      try {
        await gate.entered
        expect((await t.runtime.repository.get(pending.id))?.deliveryState).toBe('delivered')
        const consumed = await t.f.receipts()
        expect(consumed).toHaveLength(1)
        const resumeRows = await t.resumeRows(pending.id)
        expect(resumeRows).toEqual([{ state: 'resumed', approval_native_ack_id: null, approval_native_ack_record: null }])
        await t.assertNoNativeAcknowledgement(pending.id)
        await t.restart(); await response
        gate.release()
        await t.runtime.engine.resume(t.runId)
        await assertInterrupted(t, pending.executionId!)
        expect(await t.f.receipts()).toEqual(consumed)
        expect(await t.resumeRows(pending.id)).toEqual(resumeRows)
        await t.assertNoNativeAcknowledgement(pending.id)
        expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      } finally { gate.release(); await response }
    }, 90000)

    it('deduplicates open and terminal responses without replaying native work or another occurrence', async () => {
      const t = await setup(form), first = await startWaiting(t), input = approvalResponse(first)
      const entered = deferred(), release = deferred()
      t.f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
      const firstReply = t.runtime.service.respond(t.responder, input)
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      // Keep the Run OPEN while the second request reads the real decision.
      // Promise.all without this gate races completion and legitimately gets
      // EXECUTION_STOPPED for the late caller on an ordinary two-node Run.
      try {
        await entered.promise
        const duplicate = await t.runtime.service.respond(t.responder, input)
        expect(duplicate.replayed).toBe(true)
        expect(t.faults.responseWrites).toHaveLength(1)
        release.resolve()
        expect(await firstReply).toMatchObject({ value: { replayed: false } })
      } finally { release.resolve(); await firstReply; delete t.f.provider.beforeRespond }
      expect(t.f.provider.counts.responses).toBe(1)
      if (form === 'repeat') {
        const second = await t.onePending(), receipts = await t.f.receipts(), head = (await t.compare()).asOfSequence
        expect(second.executionId).not.toBe(first.executionId)
        expect(second.nativeRequestId).not.toBe(first.nativeRequestId)
        expect((await t.runtime.service.respond(t.responder, input)).replayed).toBe(true)
        expect(await t.runtime.repository.get(second.id)).toEqual(second)
        expect(await t.f.receipts()).toEqual(receipts)
        expect((await t.compare()).asOfSequence).toBe(head)
        const conflicting = first.responseOptions.find((item) => item.optionId !== input.optionId)!
        await expect(t.runtime.service.respond(t.responder, { ...input, optionId: conflicting.optionId }))
          .rejects.toBeInstanceOf(DomainError)
        expect(await t.runtime.repository.get(second.id)).toEqual(second)
        expect(t.f.provider.counts.responses).toBe(1)
      }
      await t.finishApprovals()
      await t.restart()
      const receipts = await t.f.receipts(), head = (await t.compare()).asOfSequence
      expect((await t.runtime.service.respond(t.responder, input)).replayed).toBe(true)
      expect(await t.f.receipts()).toEqual(receipts)
      expect((await t.compare()).asOfSequence).toBe(head)
      expect(t.f.provider.counts).toMatchObject({ starts: form === 'repeat' ? 4 : 2, responses: form === 'repeat' ? 2 : 1 })
      expect(await t.recoveryRows()).toHaveLength(0)
      await t.settled('succeeded')
    }, 90000)

    it('settles Stop while approval is pending and fences late response/replayed resume notifications', async () => {
      const t = await setup(form), pending = await startWaiting(t), counts = { ...t.f.provider.counts }
      expect(await t.stop()).toBe(true)
      await t.settled('canceled'); await t.assertShape(1)
      expect((await t.runtime.repository.get(pending.id))?.status).toBe('canceled')
      expect(await t.f.receipts()).toHaveLength(0)
      await expect(t.runtime.service.respond(t.responder, approvalResponse(pending)))
        .rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
      await t.runtime.engine.resumeInteraction(pending)
      expect(await t.runtime.engine.cancel(t.runId)).toBe(true)
      await t.settled('canceled'); await t.assertNoNativeAcknowledgement(pending.id)
      expect(await t.f.receipts()).toHaveLength(0)
      expect(t.f.provider.counts.starts).toBe(counts.starts)
      expect(t.f.provider.counts.responses).toBe(0)
    }, 90000)

    it('does not consume a late native ACK when Stop wins during an in-flight approval response', async () => {
      const t = await setup(form), pending = await startWaiting(t), entered = deferred(), release = deferred()
      t.f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
      const response = t.runtime.service.respond(t.responder, approvalResponse(pending))
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      try {
        await entered.promise
        await t.f.stop()
        release.resolve(); await response
        expect(await t.runtime.engine.cancel(t.runId)).toBe(true)
        await t.settled('canceled'); await t.assertShape(1)
        expect(await t.f.receipts()).toHaveLength(0)
        await expect.poll(() => t.f.provider.counts.responses, { timeout: 2000 }).toBe(1)
        // Current exchanges intentionally retire after positive cleanup. Assert
        // retained SQL identity/no ACK and absence, not a permanent UI row.
        expect(await t.runtime.repository.get(pending.id)).toMatchObject({ status: 'canceled',
          nativeSessionId: pending.nativeSessionId, nativeRequestId: pending.nativeRequestId })
        await t.assertNoNativeAcknowledgement(pending.id)
        expect((await t.compare()).state.interactions.some((item) => item.interactionId === pending.id)).toBe(false)
        expect(t.faults.responseWrites).toHaveLength(1)
        expect((await t.runtime.runs.getExecution(pending.executionId!))?.result?.outcome).toBe('canceled')
        const receipts = await t.f.receipts()
        await t.runtime.engine.resumeInteraction(pending)
        expect(await t.f.receipts()).toEqual(receipts)
        await t.settled('canceled')
      } finally { release.resolve(); await response; delete t.f.provider.beforeRespond }
    }, 90000)

    it('settles a dead mid-execution native lifetime after restart with EXECUTION_INTERRUPTED and no replay', async () => {
      const t = await setup(form, { approvals: false }), gate = t.faults.holdNextTurn()
      const started = t.runtime.engine.start(t.runId).then(() => undefined, (error: unknown) => error)
      try {
        const sessionId = await gate.entered
        const execution = (await readCurrentExecutions(t.runtime.runs, t.runId)).find((item) => item.nativeSessionId === sessionId)!
        expect(execution.state).toBe('running')
        await t.compare()
        t.faults.killOnRestart = true
        await t.restart(); await started
        expect(t.faults.deadSessions.has(sessionId)).toBe(true)
        const detached = await t.closureRows()
        await t.recoverUntilSettled(); await assertInterrupted(t, execution.id)
        expect(await t.closureRows()).toEqual(detached)
        expect(t.f.provider.counts).toMatchObject({ starts: 1, responses: 0, attaches: 0 })
      } finally { gate.release(); await started }
    }, 90000)

    it('Stop reaches cleanup settlement after a mid-execution backend restart', async () => {
      const t = await setup(form, { approvals: false }), gate = t.faults.holdNextTurn()
      const started = t.runtime.engine.start(t.runId).then(() => undefined, (error: unknown) => error)
      try {
        const sessionId = await gate.entered
        expect((await t.runtime.runs.get(t.runId))?.executionState).toBe('running')
        await t.compare()
        t.faults.killOnRestart = true
        await t.restart(); await started
        expect(t.faults.deadSessions.has(sessionId)).toBe(true)
        expect(await t.stop()).toBe(true)
        await t.settled('canceled'); await t.assertShape(1)
        expect(await t.recoveryRows()).toHaveLength(1)
        expect(t.f.provider.counts).toMatchObject({ starts: 1, responses: 0, attaches: 0 })
        expect(await t.f.receipts()).toHaveLength(0)
        const receipts = await t.recoveryRows()
        expect(await t.runtime.engine.cancel(t.runId)).toBe(true)
        expect(await t.recoveryRows()).toEqual(receipts)
      } finally { gate.release(); await started }
    }, 90000)

    it('does not strand proven delivery when the native process dies before graph acknowledgement', async () => {
      const t = await setup(form), { pending } = await loseGraphAcknowledgement(t)
      t.faults.killOnRestart = true
      await t.restart()
      expect(t.faults.deadSessions.has(pending.nativeSessionId)).toBe(true)
      await t.recoverUntilSettled(); await assertInterrupted(t, pending.executionId!)
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
    }, 90000)

    it('settles Stop with missing response proof and a dead session, without manufacturing an ACK', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      t.faults.hideResponseEvidence = true
      const sent = await t.runtime.service.respond(t.responder, approvalResponse(pending))
      expect(sent.interaction.deliveryState).toBe('uncertain')
      expect(await t.f.receipts()).toHaveLength(0)
      await t.compare()
      t.faults.killOnRestart = true
      await t.restart()
      expect(t.faults.deadSessions.has(pending.nativeSessionId)).toBe(true)
      expect(await t.stop()).toBe(true)
      await t.settled('canceled'); await t.assertShape(1)
      expect((await t.runtime.repository.get(pending.id))?.deliveryState).not.toBe('delivered')
      await t.assertNoNativeAcknowledgement(pending.id)
      expect(await t.f.receipts()).toHaveLength(0)
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      expect(t.faults.responseWrites).toHaveLength(1)
    }, 90000)

    it('keeps cleanup pending without positive process evidence, then settles the same lifetime when evidence is available', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      t.faults.killOnRestart = true
      await t.restart()
      const detached = await t.closureRows()
      t.faults.recoveryAvailable = false
      await expect(t.runtime.engine.start(t.runId)).rejects.toBeInstanceOf(AggregateError)
      expect((await t.runtime.runs.get(t.runId))?.executionState).not.toBe('completed')
      expect(await t.runtime.runs.hasPendingCleanup(t.runId)).toBe(true)
      expect(await t.recoveryRows()).toHaveLength(0)
      expect((await t.compare()).state.run.cleanupPending).toBe(true)
      await t.assertNoNativeAcknowledgement(pending.id)
      t.faults.recoveryAvailable = true
      await t.recoverUntilSettled(); await assertInterrupted(t, pending.executionId!)
      const closures = await t.closureRows()
      expect(closures.slice(0, detached.length)).toEqual(detached)
      expect(closures).toHaveLength(detached.length + 1)
      expect(closures.at(-1)).toMatchObject({ execution_id: pending.executionId,
        expected_reference: { nativeSessionId: pending.nativeSessionId }, closed_at: null, detached_at: null })
      expect((await t.recoveryRows())[0]?.generation).toBe(String(closures.at(-1)!.generation))
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 0, attaches: 0 })
    }, 90000)
  })
}
