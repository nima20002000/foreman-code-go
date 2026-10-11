import { beforeEach, expect, it, vi } from 'vitest'
import {
  DurableInteractionSchema,
  HarnessExecutionSchema,
  type PendingNativeInteraction,
} from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { DomainError } from '../errors.js'
import type { RunOwnership } from '../runs/ownership.js'
import { openWorkflowLifecycleLocked } from '../runs/repeatLifecycle.js'
import { nativeLanes } from '../../../test/helpers/nativeLanes.js'
import { ApprovalExecutionCoordinator } from './execution.js'
import { assertSavedPendingApprovalOriginalLocked } from './nativeApprovalProof.js'
import { readDetachedWorkflowSession, readRemoteWorkflowContinuation } from './workflowClosure.js'

vi.mock('./workflowClosure.js', async importOriginal => ({
  ...await importOriginal<typeof import('./workflowClosure.js')>(),
  readDetachedWorkflowSession: vi.fn(),
  readRemoteWorkflowContinuation: vi.fn(),
}))
vi.mock('./nativeApprovalProof.js', async importOriginal => ({
  ...await importOriginal<typeof import('./nativeApprovalProof.js')>(),
  assertSavedPendingApprovalOriginalLocked: vi.fn(),
}))
vi.mock('../runs/repeatLifecycle.js', async importOriginal => ({
  ...await importOriginal<typeof import('../runs/repeatLifecycle.js')>(),
  openWorkflowLifecycleLocked: vi.fn(),
}))

beforeEach(() => vi.resetAllMocks())

async function recoverRequester(detached: boolean) {
  const base = makeCurrentWorkflowFixture('requester-recovery', 'approval')
  base.run.executionState = 'waiting'
  const configuration = base.configurations[1]!
  const execution = HarnessExecutionSchema.parse({
    id: 'requester-execution', runId: base.run.id, workflowNodeId: base.version.definition.nodes[1]!.id,
    agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
    attempt: 1, state: 'waiting', createdAt: base.createdAt, input: {},
    nativeSessionId: 'requester-session', workingDirectory: '/project', runtimeDirectory: '/runtime',
  })
  const session = { harness: 'codex' as const, providerVersion: 'synthetic', nativeSessionId: execution.nativeSessionId! }
  const interaction = DurableInteractionSchema.parse({
    id: 'pending-approval', revision: 0, workspaceId: base.run.workspaceId, workflowId: base.run.workflowId,
    runId: base.run.id, executionId: execution.id, requestingAgentId: execution.agentId, ...session,
    graphThreadId: base.run.id, graphInterruptId: 'saved-interrupt',
    nativeRequestId: 'original-request', nativeRequestType: 'item/commandExecution/requestApproval',
    request: { command: 'synthetic' }, approval: base.run.approval,
    status: 'pending', deliveryState: 'not_started',
    responseOptions: [{ optionId: 'approve', semantic: 'approve_once', label: 'Approve once',
      persistence: 'request', affectsOtherPendingRequests: false,
      interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    createdAt: base.createdAt, updatedAt: base.createdAt,
  })
  const original: PendingNativeInteraction = {
    session, turn: { nativeTurnId: 'original-turn', nativeRequestId: interaction.nativeRequestId },
    nativeRequestType: interaction.nativeRequestType, request: interaction.request,
    responseOptions: interaction.responseOptions,
  }
  const history = { events: [], pendingInteractions: [original] }
  const continuation = { session, generation: '1', principalId: 'original-principal', detached }
  vi.mocked(readDetachedWorkflowSession).mockResolvedValue(detached ? session : undefined)
  vi.mocked(readRemoteWorkflowContinuation).mockImplementation(async () => structuredClone(continuation))
  vi.mocked(openWorkflowLifecycleLocked).mockResolvedValue({} as Awaited<ReturnType<typeof openWorkflowLifecycleLocked>>)
  vi.mocked(assertSavedPendingApprovalOriginalLocked).mockResolvedValue({
    original: { type: 'history', history },
  } as Awaited<ReturnType<typeof assertSavedPendingApprovalOriginalLocked>>)
  const releaseRetention = vi.fn(async () => {})
  const owner = {
    runId: base.run.id, assertOwned: vi.fn(), retain: vi.fn(() => releaseRetention), release: vi.fn(async () => {}),
    oneShotConnection: () => ({ transaction: async (work: (sql: unknown) => Promise<unknown>) => work({}) }),
  } as unknown as RunOwnership
  const acquireOwnership = vi.fn(async (): Promise<RunOwnership | undefined> => undefined)
  const attach = vi.fn(async () => session)
  const manager = {
    harness: 'codex', attachSession: attach, reconcile: async () => history,
    originalApplicationAccess: async () => ({ token: 'synthetic-token' }),
    closeForRestart: async () => {},
  }
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordination = nativeLanes()
  const coordinator = new ApprovalExecutionCoordinator({
    getExecution: async () => execution, getExecutionConfiguration: async () => configuration,
    getRepeatVersion: async () => base.version, get: async () => base.run,
    async *executionPages() { yield [execution] }, acquireOwnership,
  } as unknown as Args[0], { coordination } as Args[1], {} as Args[2], {
    resolve: () => ({ manager, processState: 'needs_start', markResident() {} }),
  } as unknown as Args[3], 60_000, {
    restore: async () => ({ principalId: continuation.principalId,
      environment: { agentId: execution.agentId, variables: {} } }),
  } as unknown as Args[5], undefined, {
    begin: async () => {
      continuation.generation = '2'
      continuation.detached = false
      return continuation.generation
    },
    recordDetached: async () => {},
  } as unknown as Args[7], undefined, undefined, undefined, undefined, undefined,
  async context => ({ ...context, acceptedPlacement: { hostRef: { kind: 'device' } } as
    NonNullable<typeof context.acceptedPlacement> }))
  const stopSharing = coordinator.shareRunOwner(owner)
  try {
    expect(await coordinator.requestColdRunCleanup(owner, [interaction])).toBe(false)
  } finally {
    stopSharing()
  }
  return { coordinator, interaction, owner, acquireOwnership, attach, releaseRetention, coordination }
}

it.each([false, true])('keeps the requester recovery owner for delivery after engine sharing ends (detached=%s)',
  async detached => {
    const f = await recoverRequester(detached)
    try {
      const deliver = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted()
        return 'delivered'
      })
      expect(await f.coordinator.withInteractionOwner(f.interaction, new AbortController().signal, deliver))
        .toBe('delivered')
      expect(f.acquireOwnership).not.toHaveBeenCalled()
      expect(f.owner.retain).toHaveBeenCalledTimes(1)
      expect(f.releaseRetention).toHaveBeenCalledTimes(1)
      expect(f.attach).toHaveBeenCalledTimes(1)
      expect((await f.coordination.getLane('codex', f.interaction.nativeSessionId))?.leaseToken).toBeUndefined()
    } finally {
      await f.coordinator.closeForRestart()
    }
  },
)

it('rejects delivery when the recovered requester owner has been lost', async () => {
  const f = await recoverRequester(true)
  const assertOwned = vi.mocked(f.owner.assertOwned)
  assertOwned.mockImplementation(() => {
    throw new DomainError('RUN_OWNERSHIP_LOST', 'The saved owner disconnected.', 409)
  })
  try {
    const deliver = vi.fn(async () => 'delivered')
    await expect(f.coordinator.withInteractionOwner(f.interaction, new AbortController().signal, deliver))
      .rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
    expect(f.acquireOwnership).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  } finally {
    assertOwned.mockImplementation(() => {})
    await f.coordinator.closeForRestart()
  }
})
