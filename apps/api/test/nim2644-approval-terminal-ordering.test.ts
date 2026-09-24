import { describe, expect, it, vi } from 'vitest'
import { HarnessExecutionRequestSchema, HarnessExecutionSchema, type DurableInteraction } from '@graphql/contracts'
import { DomainError } from '../src/modules/errors.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { assertApprovalTerminalSettlement } from '../src/modules/interactions/wave25/resume.js'
import { decisionDigest } from '../src/modules/interactions/wave25/publication.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { oneShotExecutionDriver, type OneShotRuntimeContext } from '../src/modules/runs/oneShotRuntime.js'
import { approvalFixture, deliveryFixture } from './helpers/wave25ApprovalFixture.js'

// The companion PostgreSQL suite exercises ownership/checkpoint/native evidence.
// This suite isolates receipt composition and coordinator error classification.

const pending = () => new DomainError('APPROVAL_SETTLEMENT_PENDING', 'Exact settlement is pending.', 409)
function settledInteraction(): DurableInteraction {
  const i = deliveryFixture().interaction
  return { ...i, graphThreadId: i.runId, graphInterruptId: 'exact-interrupt', status: 'delivered', deliveryState: 'delivered', deliveredAt: i.updatedAt }
}
function receiptDigest(i: DurableInteraction) {
  return graphSourceDigest({ interactionId: i.id, runId: i.runId, executionId: i.executionId,
    graphThreadId: i.graphThreadId, graphInterruptId: i.graphInterruptId ?? null, decision: decisionDigest(i) })
}
function gateFixture() {
  const interaction = settledInteraction()
  const state = {
    records: [interaction], resume: { state: 'resumed', approval_native_ack_id: 'qualified-native-ack' as string | null },
    receipt: receiptDigest(interaction) as string | undefined,
  }
  const query = vi.fn(async (text: string) => {
    if (text.includes('from durable_interactions')) return {
      rows: state.records.map((i) => ({ id: i.id, execution_id: i.executionId, record: i })), rowCount: state.records.length,
    }
    if (text.includes('from interaction_graph_resumes')) return { rows: [state.resume], rowCount: 1 }
    if (text.includes('from run_graph_effects')) return {
      rows: state.receipt ? [{ effect_digest: state.receipt }] : [], rowCount: state.receipt ? 1 : 0,
    }
    throw new Error(`Unexpected SQL: ${text}`)
  })
  const check = () => assertApprovalTerminalSettlement({ query } as unknown as GraphTransactionSql, interaction.runId, interaction.executionId)
  return { interaction, state, query, check }
}

describe('NIM-2644 native terminal / approval settlement ordering', () => {
  it.each(['submitted', 'uncertain'] as const)('does not recover a terminal execution through %s delivery', async (deliveryState) => {
    const runs = { getExecution: vi.fn(), appendNativeEvent: vi.fn(), updateExecution: vi.fn() }
    const resolver = { resolve: vi.fn(() => { throw new Error('Unconfirmed delivery must not attach or respond') }) }
    const coordinator = new ApprovalExecutionCoordinator(
      runs as unknown as ConstructorParameters<typeof ApprovalExecutionCoordinator>[0],
      { coordination: {} } as ConstructorParameters<typeof ApprovalExecutionCoordinator>[1],
      {} as ConstructorParameters<typeof ApprovalExecutionCoordinator>[2],
      resolver as unknown as ConstructorParameters<typeof ApprovalExecutionCoordinator>[3], 60_000)
    const owner = { assertOwned: vi.fn() } as unknown as Parameters<typeof coordinator.recoverTerminalInteraction>[1]
    for (const option of ['approve-once', 'reject']) {
      const i = { ...deliveryFixture().interaction, deliveryState, selectedOptionId: option }
      expect(await coordinator.recoverTerminalInteraction(i, owner, new AbortController().signal)).toBe(false)
    }
    expect(runs.getExecution).not.toHaveBeenCalled()
    expect(runs.updateExecution).not.toHaveBeenCalled()
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it.each(['not_started', 'submitted', 'uncertain', 'failed'] as const)('rejects %s even with terminal-looking resume rows', async (deliveryState) => {
    const f = gateFixture()
    f.state.records = [{ ...f.interaction, status: deliveryState === 'not_started' ? 'decided' : deliveryState === 'failed' ? 'delivery_failed' : 'delivery_pending', deliveryState, deliveredAt: undefined }]
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it.each(['pending', 'resuming', 'blocked', 'canceled'])('rejects delivered approval with %s outbox', async (state) => {
    const f = gateFixture(); f.state.resume.state = state
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('does not mistake a committed checkpoint for Worker acknowledgement', async () => {
    const f = gateFixture(); f.state.resume.approval_native_ack_id = null
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('does not accept an acknowledgement without the exact checkpoint receipt', async () => {
    const f = gateFixture(); f.state.receipt = undefined
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('rejects a contradictory receipt rather than rewriting it', async () => {
    const f = gateFixture(); f.state.receipt = graphSourceDigest({ otherDecision: true })
    await expect(f.check()).rejects.toMatchObject({ code: 'GRAPH_EFFECT_CONFLICT' })
  })
  it('does not hide a canceled delivered obligation during normal completion', async () => {
    const f = gateFixture(); f.state.records = [{ ...f.interaction, status: 'canceled' }]
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('accepts exact settled replay without writing or dispatching anything', async () => {
    const f = gateFixture()
    await f.check(); await f.check()
    expect(f.query.mock.calls.every(([text]) => text.trimStart().startsWith('select'))).toBe(true)
  })
  it('checks every selected sibling rather than just the first receipt', async () => {
    const f = gateFixture()
    f.state.records.push({ ...f.interaction, id: 'unsettled-sibling', deliveryState: 'uncertain', status: 'delivery_pending', deliveredAt: undefined })
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('cannot accept a foreign graph thread', async () => {
    const f = gateFixture(); f.state.records = [{ ...f.interaction, graphThreadId: 'other-run' }]
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_IDENTITY_MISMATCH' })
  })
})

function coordinatorFixture() {
  const f = approvalFixture(), configuration = f.configurations[1]!
  const execution = HarnessExecutionSchema.parse({ ...f.executions[1]!, workingDirectory: '/task/project', runtimeDirectory: '/task/runtime' })
  const session = { harness: 'codex' as const, providerVersion: 'synthetic-test', nativeSessionId: execution.nativeSessionId! }
  const interaction = { ...settledInteraction(), graphThreadId: f.run.id }
  const history = { events: [], pendingInteractions: [], correlationId: `execution:${execution.id}`, nativeTurnId: 'turn-pwd',
    terminalTurn: { correlationId: `execution:${execution.id}`, providerId: 'turn-pwd', result: { outcome: 'succeeded', output: { exitCode: 0 } } } }
  const manager = { reconcile: vi.fn(async () => history), close: vi.fn(), cancel: vi.fn(),
    withLane: vi.fn(async (_session: unknown, _correlation: unknown, _signal: unknown,
      work: (native: unknown, lane: unknown) => Promise<unknown>) => work(manager, {
      fence: { id: 'lane', token: 'token' }, guard: { signal: new AbortController().signal, check: vi.fn() },
    })) }
  const runs = { ensureExecution: vi.fn(async () => ({ execution, created: false })),
    updateExecution: vi.fn(async () => { throw pending() }), appendNativeEvent: vi.fn() }
  const budgets = { ensure: vi.fn(), resume: vi.fn(), remaining: vi.fn(async () => 60_000),
    assertActive: vi.fn(), beginWait: vi.fn(), finish: vi.fn() }
  const interactions = { getForExecution: vi.fn(async () => interaction), cancelPendingForExecution: vi.fn(),
    coordination: { finalizeWorkflowSession: vi.fn() } }
  const coordinator = new ApprovalExecutionCoordinator(
    runs as unknown as ConstructorParameters<typeof ApprovalExecutionCoordinator>[0],
    interactions as unknown as ConstructorParameters<typeof ApprovalExecutionCoordinator>[1],
    budgets as unknown as ConstructorParameters<typeof ApprovalExecutionCoordinator>[2],
    {} as ConstructorParameters<typeof ApprovalExecutionCoordinator>[3], 60_000)
  vi.spyOn(coordinator as unknown as { resolveManager(): unknown }, 'resolveManager')
    .mockReturnValue({ manager, processState: 'resident' })
  const owner = { runId: f.run.id, assertOwned: vi.fn() } as unknown as Parameters<typeof coordinator.ensureObserve>[0]['owner']
  const request = HarnessExecutionRequestSchema.parse({ executionId: execution.id, runId: execution.runId,
    workspaceId: configuration.workspaceId, workflowNodeId: execution.workflowNodeId,
    workingDirectory: execution.workingDirectory, runtimeDirectory: execution.runtimeDirectory,
    configuration, input: execution.input })
  const observe = () => coordinator.ensureObserve({ candidate: execution, request, approval: f.run.approval,
    workflowId: f.run.workflowId, graphThreadId: f.run.id, owner, signal: new AbortController().signal })
  return { execution, session, runs, budgets, interactions, manager, observe }
}

describe('NIM-2644 pending receipt is not native failure cleanup', () => {
  it('retains requester, budget wait and credential lifetime after terminal publication is refused', async () => {
    const f = coordinatorFixture()
    await expect(f.observe()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(f.execution.state).toBe('waiting')
    expect(f.runs.updateExecution).toHaveBeenCalledTimes(1)
    expect(f.budgets.beginWait).toHaveBeenCalledWith(f.execution.id)
    expect(f.budgets.finish).not.toHaveBeenCalled()
    expect(f.manager.close).not.toHaveBeenCalled()
    expect(f.manager.cancel).not.toHaveBeenCalled()
    expect(f.interactions.cancelPendingForExecution).not.toHaveBeenCalled()
    expect(f.interactions.coordination.finalizeWorkflowSession).not.toHaveBeenCalled()
  })

  it('keeps a failed budget-pause write recoverable instead of canceling the approval', async () => {
    const f = coordinatorFixture()
    f.budgets.beginWait.mockRejectedValueOnce(new Error('Synthetic budget persistence gap'))
    await expect(f.observe()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(f.execution.state).toBe('waiting')
    expect(f.budgets.finish).not.toHaveBeenCalled()
    expect(f.manager.close).not.toHaveBeenCalled()
    expect(f.manager.cancel).not.toHaveBeenCalled()
    expect(f.interactions.cancelPendingForExecution).not.toHaveBeenCalled()
    expect(f.interactions.coordination.finalizeWorkflowSession).not.toHaveBeenCalled()
  })

  it.each([false, true])('one-shot driver preserves receipt gap; explicit Stop=%s stays distinct', async (stop) => {
    const f = approvalFixture(), configuration = f.configurations[1]!
    const execution = HarnessExecutionSchema.parse({ ...f.executions[1]!, workingDirectory: '/task/project', runtimeDirectory: '/task/runtime' })
    const controller = new AbortController()
    const store = { claimLaunch: vi.fn(async () => undefined), recoverSession: vi.fn(async () => execution),
      assertNativeBoundary: vi.fn(), failExecution: vi.fn() }
    const runs = { oneShot: () => store, getExecution: vi.fn(), hasRequestedStop: vi.fn(async () => stop), requestCleanup: vi.fn() }
    const context = {
      run: { ...f.run, executionLocation: { rootPath: '/task/project' } }, version: f.version, runs,
      workflows: { getAgentConfiguration: vi.fn(async () => configuration) },
      native: { ensureObserve: vi.fn(async () => { if (stop) controller.abort(); throw pending() }) },
      locations: { revalidateSnapshot: vi.fn() }, owner: { assertOwned: vi.fn() }, signal: controller.signal,
      admission: { run: async (_id: string, _signal: AbortSignal, work: () => Promise<void>) => work() },
      directory: () => '/task/runtime',
    } as unknown as OneShotRuntimeContext
    await expect(oneShotExecutionDriver(context).observe(execution, controller.signal)).rejects.toMatchObject({
      code: stop ? 'WORKFLOW_SELECTED_EXECUTION_FAILED' : 'APPROVAL_SETTLEMENT_PENDING',
    })
    if (stop) expect(store.failExecution).toHaveBeenCalledWith(execution.id, 'EXECUTION_INTERRUPTED', true)
    else expect(store.failExecution).not.toHaveBeenCalled()
    expect(runs.requestCleanup).not.toHaveBeenCalled()
  })
})
