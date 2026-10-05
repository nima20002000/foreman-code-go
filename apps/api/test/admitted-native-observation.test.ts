import { expect, it, vi } from 'vitest'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import type { NativeHarnessSessionManager, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { request } from './opencode-fixtures.js'
import { OPENCODE_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'

it('forwards observation attachment and retains history/cancel access without new-work capability', async () => {
  const session = { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'saved-session' }
  const start: NativeSessionStart = { request: request(), correlationId: 'saved-request' }
  const attach = vi.fn(async () => session)
  const create = vi.fn(async () => session)
  const respond = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => true)
  const history = vi.fn(async () => ({ events: [], pendingInteractions: [] }))
  const actual = { harness: 'opencode', attachSessionForObservation: attach, createSession: create,
    respond, cancel, history } as unknown as NativeHarnessSessionManager
  const initialize = vi.fn(async () => ({ manager: actual }))
  const { manager } = createAdmittedNativeManager('opencode', initialize)
  expect(await manager.attachSessionForObservation!(session, start)).toEqual(session)
  expect(initialize).toHaveBeenCalledWith(expect.any(AbortSignal), { purpose: 'observation', session, start })
  expect(attach).toHaveBeenCalledWith(session, start, undefined)
  expect(await manager.history(session)).toEqual({ events: [], pendingInteractions: [] })
  expect(await manager.cancel(session)).toBe(true)
  await expect(manager.createSession(start)).rejects.toMatchObject({ code: 'HARNESS_OBSERVATION_ONLY' })
  await expect(manager.attachSession(session, start)).rejects.toMatchObject({ code: 'HARNESS_OBSERVATION_ONLY' })
  await expect(manager.respond(session, 'approval', OPENCODE_APPROVAL_OPTIONS_FIXTURE[0]!))
    .rejects.toMatchObject({ code: 'HARNESS_OBSERVATION_ONLY' })
  const turn = manager.startTurn(session, { prompt: 'More work', clientCorrelationId: 'new-request' })
  await expect(turn[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'HARNESS_OBSERVATION_ONLY' })
  expect(create).not.toHaveBeenCalled()
  expect(respond).not.toHaveBeenCalled()
  await manager.dispose?.()
})
