import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'
import { DomainError } from '../src/modules/errors.js'

// The provider boundary is controllable; launch, publication, ownership and shutdown use production SQL/services.
describe.runIf(postgresEnabled)('workflow startup preservation', () => {
  it('reloads a starting execution after its original session and first native batch commit', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    const runtime = await checkpointRuntimeFixture(1, 1, {
      fixture, approvalNodeIds: [fixture.version.entryNodeId],
    })
    const opening = deferred()
    const publish = deferred()
    const captured = deferred()
    const originalConnection = runtime.provider.connection.bind(runtime.provider)
    const detached: NativeSessionReference[] = []
    let original: NativeSessionReference | undefined
    const connections = vi.spyOn(runtime.provider, 'connection').mockImplementation(() => {
      const manager = originalConnection()
      return { ...manager,
        createSession: async (...args) => {
          original = await manager.createSession(...args)
          opening.resolve()
          await publish.promise
          return original
        },
        canDetachForRestart: () => true,
        closeForRestart: async session => { detached.push(session) },
      }
    })
    let shutdown: Promise<void> | undefined
    let startup: Promise<unknown> | undefined
    let restorePages = () => undefined as void
    try {
      startup = runtime.engine.start(runtime.f.run.id).then(
        () => undefined,
        (error: unknown) => error,
      )
      await opening.promise
      const before = (await runtime.db.pool.query<{ record: { id: string; state: string } }>(
        'select record from harness_executions where run_id=$1', [runtime.f.run.id])).rows[0]!.record
      expect(before).toMatchObject({ state: 'starting' })
      expect(before).not.toHaveProperty('nativeSessionId')
      const executionPages = runtime.runs.executionPages.bind(runtime.runs)
      const pages = vi.spyOn(runtime.runs, 'executionPages').mockImplementation(async function* (...args) {
        for await (const executions of executionPages(...args)) {
          captured.resolve()
          yield executions
        }
      })
      restorePages = () => pages.mockRestore()
      shutdown = runtime.engine.shutdown()
      await captured.promise
      publish.resolve()
      await shutdown
      const startupError = await startup
      expect(startupError).toBeInstanceOf(DomainError)
      expect(startupError).toMatchObject({ code: 'ENGINE_RESTART' })
      expect(detached).toEqual([original])
      const cleanup = await runtime.db.pool.query(
        'select run_id from run_cleanup_intents where run_id=$1 and pending', [runtime.f.run.id])
      expect(cleanup.rows).toEqual([])
      const after = (await runtime.db.pool.query<{ record: { state: string } }>(
        'select record from harness_executions where id=$1', [before.id])).rows[0]!.record
      expect(after).toMatchObject({ id: before.id, nativeSessionId: original!.nativeSessionId })
      expect(['running', 'waiting']).toContain(after.state)
      expect(runtime.provider.counts).toMatchObject({ sessions: 1, starts: 1 })
      const closure = await runtime.db.pool.query<{ detached_reference: unknown }>(
        'select detached_reference from execution_native_closures where execution_id=$1 and detached_at is not null', [before.id])
      expect(closure.rows).toEqual([{ detached_reference: original }])
    } finally {
      publish.resolve()
      await Promise.allSettled([startup, shutdown])
      restorePages()
      connections.mockRestore()
      await runtime.close()
    }
  }, 60_000)
})
