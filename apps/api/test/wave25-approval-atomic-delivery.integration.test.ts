import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalAtomicSetup, decision } from './helpers/approvalAtomic.js'
import { br1002Ack, br1002Batches } from './helpers/wave25Br1002Cuts.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { deliverApproval } from '../src/modules/interactions/wave25/service.js'

const setup = approvalAtomicSetup()

describe.skipIf(!postgresEnabled)('approval delivery', { timeout: 60000 }, () => {
  it('decision, native review settlement, delivery and continuation remain separate', async () => {
    const f = await setup()
    const { compare } = await graphParity(f.pool, f.scope)
    await compare(); await decision(f)
    expect(await f.repository.delivery.claim(f.interaction.id, 'too-early')).toBeUndefined()
    expect(f.counts().responses).toBe(0)
    await f.settle(); await compare()
    const delivered = await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, f.interaction.id)
    expect(delivered.deliveryState).toBe('delivered')
    expect(f.counts().responses).toBe(1)
    expect(delivered).toMatchObject({ nativeRequestId: f.interaction.nativeRequestId,
      nativeSessionId: f.interaction.nativeSessionId, request: f.interaction.request })
    expect(await f.receipts()).toHaveLength(0)
    expect((await br1002Ack(f, f.interaction.id))?.approval_native_ack_id ?? null).toBeNull()
    await f.engine.resumeInteraction(delivered)
    expect((await f.runs.get(f.run.id))?.outcome).toBe('succeeded')
    expect(await f.repository.delivery.claim(f.interaction.id, 'duplicate')).toBeUndefined()
    expect(await f.receipts()).toHaveLength(1)
    expect((await br1002Ack(f, f.interaction.id))?.approval_native_ack_id).toMatch(/^native-approval-ack-/)
    expect((await br1002Batches(f)).flatMap((batch) => batch.facts).filter((fact) => fact.type === 'worker.resumed')).toHaveLength(1)
    await compare()
  })

  it('missing native receipt stays uncertain and retains the same reconciliation attempt', async () => {
    const f = await setup()
    await decision(f); await f.settle()
    const first = (await f.repository.delivery.claim(f.interaction.id, 'missing-receipt'))!
    const uncertain = await f.repository.delivery.finish(first, async () => ({ state: 'delivered' }))
    expect(uncertain.deliveryState).toBe('uncertain')
    const retry = (await f.repository.delivery.claim(f.interaction.id, 'reconcile-receipt'))!
    expect(retry).toMatchObject({ mode: 'reconcile', attempt: first.attempt, correlationId: first.correlationId })
    expect(f.counts().responses).toBe(0)
    expect(await f.receipts()).toHaveLength(0)
  })

  it('a changed requester generation fences a delivery owner before native writes', async () => {
    const f = await setup()
    await decision(f); await f.settle()
    const claim = (await f.repository.delivery.claim(f.interaction.id, 'old-generation'))!
    await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',to_jsonb((record->>'connectionGeneration')::integer+1)) where owner_agent_id=$1", [f.requester.agentId])
    let writes = 0
    await expect(f.repository.delivery.finish(claim, async () => { writes++; return { state: 'delivered' } })).rejects.toBeDefined()
    expect(writes).toBe(0)
    expect(f.counts().responses).toBe(0)
  })
})
