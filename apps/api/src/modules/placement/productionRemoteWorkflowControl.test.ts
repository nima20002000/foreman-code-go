import { beforeEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HarnessExecution } from '@graphql/contracts'
import type { RunOwnership } from '../runs/ownership.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { InteractionDeliveryClaim } from '../interactions/delivery.js'
import { withOriginalInteractionDeliveryClaim } from '../interactions/originalDeliveryClaim.js'
const ports = vi.hoisted(() => ({ factory: vi.fn(), admission: vi.fn(),
  intent: { runId: 'run', nodeId: 'node', executionId: 'execution', operationId: 'operation', technicalAttempt: 1 } }))
vi.mock('./persistence.js', () => ({ readDispatchIntent: async () => ports.intent, readAcceptedPlacement: async () => ({ hostRef: { kind: 'device' } }), readNativePlacement: async () => ({ original: true }) }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: async () => ports.intent }))
vi.mock('./executionBinding.js', () => ({ readNativeExecutionBinding: () => ({ workingTree: { canonicalCwd: '/original/source' } }) }))
vi.mock('./workerCarrier.js', () => ({ remoteNativeManager: ports.factory }))
vi.mock('../runs/remote/ownerControlAdmission.js', () => ({ admitRemoteOwnerControl: ports.admission }))
import { createProductionRemoteWorkflow } from './productionRemoteWorkflow.js'
import type { RemoteNativeManagerOptions } from '../runs/remote/nativeManagerProxy.js'
beforeEach(() => vi.clearAllMocks())
async function fixture() {
  // Only common callback wiring is exercised. SQL metadata and admission are explicit port doubles.
  const events: string[] = [], sql = { original: true }
  const owner = { runId: 'run', assertOwned() {}, oneShotConnection: () => ({ transaction: async (work: (sql: unknown) => Promise<unknown>) => {
    events.push('begin')
    try { const result = await work(sql); events.push('commit'); return result } catch (error) { events.push('rollback'); throw error }
  } }) } as unknown as RunOwnership
  const composition = createProductionRemoteWorkflow({ pool: {} as pg.Pool, locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({} as ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>), producer: () => undefined,
    execution: async () => ({ id: 'execution', runId: 'run', workflowNodeId: 'node', attempt: 1, workingDirectory: '/original/source' } as HarnessExecution) })
  await composition.prepare('execution')
  composition.manager({ executionId: 'execution' } as NativeManagerResolutionContext, () => owner)
  const callbacks = ports.factory.mock.calls[0]![2] as Pick<RemoteNativeManagerOptions, 'controlFor'>
  return { events, sql, owner, callbacks }
}
it('passes the original attempt/token/fence into admission and commits before carrier dispatch', async () => {
  const f = await fixture(), claim = { interaction: { id: 'interaction', revision: 7 }, attempt: 2, ownerToken: 'original-private-token', correlationId: 'original-correlation',
    deliveryFence: '4', approvalConnectionGeneration: '2', mode: 'submit' } as InteractionDeliveryClaim
  const command = { kind: 'respond' as const, native: { sessionId: 'session', processIdentityDigest: 'a'.repeat(64) }, nativeRequestId: 'native-request', option: {} }
  ports.admission.mockImplementation(async () => { f.events.push('admit'); return { commandId: 'original-command' } })
  await withOriginalInteractionDeliveryClaim(claim, async () => {
    await f.callbacks.controlFor(command)
    f.events.push('native')
  })
  expect(ports.admission).toHaveBeenCalledExactlyOnceWith(f.sql, f.owner, expect.any(Object), command, claim)
  expect(f.events).toEqual(['begin', 'admit', 'commit', 'native'])
})
it('does not dispatch when the original command is already admitted and requires reconciliation', async () => {
  const f = await fixture()
  ports.admission.mockRejectedValue(new Error('REMOTE_CONTROL_ALREADY_ADMITTED'))
  const native = vi.fn()
  await expect(f.callbacks.controlFor({ kind: 'stop', native: { sessionId: 'session', processIdentityDigest: 'a'.repeat(64) } }).then(native)).rejects.toThrow('REMOTE_CONTROL_ALREADY_ADMITTED')
  expect(f.events).toEqual(['begin', 'rollback'])
  expect(native).not.toHaveBeenCalled()
})
