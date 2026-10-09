import { describe, expect, it, vi } from 'vitest'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { deferred } from './helpers/wave25Agent3.js'

describe('native restart cleanup', () => {
  it.each([false, true])('persists cancelled startup disposal with an initial close failure of %s', async failFirst => {
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [] })
    const entered = deferred()
    const disposalEntered = deferred()
    const disposalCompleted = deferred()
    let executionId: string | undefined
    let failDisposal = failFirst
    const create = vi.fn<NativeHarnessSessionManager['createSession']>(async (input, signal) => {
      if (!isWorkflowStart(input) || !signal) throw new Error('Workflow startup requires its execution signal.')
      executionId = input.request.executionId
      entered.resolve()
      return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    })
    const dispose = vi.fn(async () => {
      disposalEntered.resolve()
      if (failDisposal) {
        failDisposal = false
        throw new Error('Original startup disposal is unconfirmed.')
      }
      await disposalCompleted.promise
    })
    const connection = f.provider.connection.bind(f.provider)
    vi.spyOn(f.provider, 'connection').mockImplementation(() => ({
      ...connection(), createSession: create, dispose,
    }))
    const active = f.engine.start(f.f.run.id)
    const activeResult = active.then(() => null, (error: unknown) => error)
    try {
      await Promise.race([entered.promise, active.then(() => {
        throw new Error('Workflow completed before startup was observed.')
      })])
      const execution = await f.runs.getExecution(executionId!)
      expect(execution?.state).toBe('starting')
      expect(execution?.nativeSessionId).toBeUndefined()
      const closures = new PostgresWorkflowClosureStore(f.db.pool)
      const closing = f.engine.shutdown()
      if (failFirst) {
        await expect(closing).rejects.toThrow('closure or task draining remains unconfirmed')
        expect(await closures.readUnbound(execution!)).toBeUndefined()
        expect(dispose).toHaveBeenCalledOnce()
      }
      const retry = failFirst ? f.engine.shutdown() : closing
      await disposalEntered.promise
      expect(await closures.readUnbound(execution!)).toBeUndefined()
      const competingOwner = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => {})
      try { expect(competingOwner).toBeUndefined() } finally { await competingOwner?.release() }
      disposalCompleted.resolve()
      await retry
      expect(await activeResult).not.toBeNull()
      expect(await closures.readUnbound(execution!)).toMatchObject({ execution: { id: execution!.id } })
      expect(await f.runs.getExecution(execution!.id)).toEqual(execution)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('pending')
      expect(create).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledTimes(failFirst ? 2 : 1)
      const nextOwner = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => {})
      try { expect(nextOwner).toBeDefined() } finally { await nextOwner?.release() }
    } finally {
      disposalCompleted.resolve()
      try { await f.close() } finally { vi.restoreAllMocks() }
    }
  }, 60_000)
})
