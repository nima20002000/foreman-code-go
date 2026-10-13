import { expect, it, vi } from 'vitest'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'

const setup = createApprovalRecoverySetup()

it.each(['execution read', 'native attachment', 'native reconciliation'] as const)(
  'retries a transient %s failure without fencing or replacing the pending requester', async stage => {
    const t = await setup('ordinary')
    const pending = await startWaiting(t)
    const original = await t.runtime.runs.getExecution(pending.executionId!)
    const principal = (await t.f.db.pool.query('select principal_id from worker_credential_bindings where execution_id=$1',
      [pending.executionId])).rows[0]!.principal_id
    await t.restart()
    const error = new Error('Query read timeout')
    let injected = false
    if (stage === 'execution read') {
      const read = t.runtime.runs.getExecution.bind(t.runtime.runs)
      vi.spyOn(t.runtime.runs, 'getExecution').mockImplementation(async (...args) => {
        // Recovery passes the Run owner to its scan; attach performs the ownerless read.
        if (!args[1] && !injected) { injected = true; throw error }
        return read(...args)
      })
    } else if (stage === 'native attachment') {
      const attach = t.f.provider.attachSession.bind(t.f.provider)
      vi.spyOn(t.f.provider, 'attachSession').mockImplementation(async (...args) => {
        if (!injected) { injected = true; throw error }
        return attach(...args)
      })
    } else {
      const reconcile = t.f.provider.reconcile.bind(t.f.provider)
      vi.spyOn(t.f.provider, 'reconcile').mockImplementation(async (...args) => {
        if (!injected) { injected = true; throw error }
        return reconcile(...args)
      })
    }
    await expect(t.runtime.engine.prepareInteraction(pending)).rejects.toThrow('Query read timeout')
    expect(injected).toBe(true)
    expect(await t.runtime.runs.hasPendingCleanup(t.runId)).toBe(false)
    expect(await t.runtime.repository.get(pending.id)).toEqual(pending)
    expect(await t.runtime.runs.getExecution(pending.executionId!)).toEqual(original)
    await t.runtime.engine.prepareInteraction(pending)
    const live = (await t.f.db.pool.query('select principal_id,revoked_at from worker_credential_bindings where execution_id=$1',
      [pending.executionId])).rows
    expect(live).toEqual([{ principal_id: principal, revoked_at: null }])
    const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
    expect(response.interaction.deliveryState).toBe('delivered')
    await t.finishApprovals()
    expect(t.f.provider.counts.responses).toBe(1)
    expect(t.f.provider.counts.starts).toBe(2)
  }, 90_000,
)
