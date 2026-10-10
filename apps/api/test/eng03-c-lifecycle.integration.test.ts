import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { deferred, postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { ApprovalTransportFaults } from './helpers/eng06ApprovalFaults.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!(); vi.restoreAllMocks() })
async function fixture() {
  const f = await checkpointRuntimeFixture(2); closes.push(f.close); return f
}

// The deterministic boundary is the provider transport. Production admission,
// private native capture, receipts, checkpointing and lifecycle writers remain real.
describe.skipIf(!postgresEnabled)('ENG-03 C current native lifecycle with durable parallel branches', () => {
  it('acknowledges Stop when the queued launch loses the durable Stop race', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    const update = f.runs.updateState.bind(f.runs)
    vi.spyOn(f.runs, 'updateState').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return update(...args)
    })
    const started = f.engine.start(f.f.run.id).then(() => undefined, (error: unknown) => error)
    try {
      await entered.promise
      await f.stop()
      release.resolve()
      expect(await started).toBeUndefined()
      await f.engine.cancel(f.f.run.id)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('canceled')
      expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
      expect(await readCurrentExecutions(f.runs, f.f.run.id)).toHaveLength(0)
      expect(f.provider.counts.starts).toBe(0)
    } finally { release.resolve(); await started }
  }, 60000)

  it('stops both waiting branches and leaves another queued Run intact', async () => {
    const f = await fixture(), other = await fixture()
    const { compare } = await graphParity(f.db.pool, f.f.scope)
    await f.engine.start(f.f.run.id)
    expect(await f.pending()).toHaveLength(2)
    expect(f.provider.counts.starts).toBe(3)
    await compare(); await f.stop(); await f.engine.cancel(f.f.run.id)
    expect((await compare()).state.run.outcome).toBe('canceled')
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect((await other.runs.get(other.f.run.id))?.executionState).toBe('queued')
    expect(other.provider.counts.starts).toBe(0)
    expect(f.provider.counts.starts).toBe(3)
  }, 60000)

  it('fails the Run after a provider exits abnormally and settles the waiting sibling', async () => {
    const f = await fixture()
    const original = f.provider.startTurn.bind(f.provider)
    const history = f.provider.history.bind(f.provider)
    const create = f.provider.createSession.bind(f.provider)
    const failing = f.f.version.definition.nodes[2]!.id
    let failedSession: string | undefined
    let terminal: import('@foreman-code/contracts').NativeHarnessEvent | undefined
    const result = { outcome: 'failed' as const,
      error: { code: 'SYNTHETIC_PROCESS_EXIT', message: 'Task-owned provider exited.', retryable: false } }
    vi.spyOn(f.provider, 'createSession').mockImplementation(async (input) => {
      const session = await create(input)
      if (isWorkflowStart(input) && input.request.workflowNodeId === failing) failedSession = session.nativeSessionId
      return session
    })
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      for await (const event of original(session, input)) {
        if (session.nativeSessionId === failedSession && event.type === 'turn.started') {
          yield event
          terminal = { ...event, sequence: event.sequence + 1, type: 'turn.completed',
            payload: { ...event.payload, turn: { id: event.payload.turnId, status: 'failed', error: { message: result.error.message } } } }
          yield terminal
          return
        }
        yield event
      }
    })
    vi.spyOn(f.provider, 'history').mockImplementation(async (session) =>
      session.nativeSessionId === failedSession && terminal
        ? { events: [terminal], pendingInteractions: [], responseDeliveries: [], terminalResult: result }
        : history(session))
    await f.engine.start(f.f.run.id).catch(() => undefined)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('failed')
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect(f.provider.counts.starts).toBe(3)
    expect((await readCurrentExecutions(f.runs, f.f.run.id)).every((item) => item.state === 'completed')).toBe(true)
  }, 60000)

  it('deduplicates Start and reconciliation while native dispatch is active', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    const original = f.provider.createSession.bind(f.provider)
    vi.spyOn(f.provider, 'createSession').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return original(...args)
    })
    const task = f.engine.start(f.f.run.id)
    try {
      await entered.promise
      expect(f.engine.start(f.f.run.id)).toBe(task)
      await f.engine.reconcile()
      release.resolve(); await task
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3 })
      expect(new Set(f.provider.startedNodes).size).toBe(3)
    } finally { release.resolve(); await task.catch(() => undefined) }
  }, 60000)

  it('closes a cold waiting sibling without replaying its accepted predecessor', async () => {
    const faults = new ApprovalTransportFaults()
    const f = await checkpointRuntimeFixture(2, 1, {
      recoverNativeProcesses: (executionId, signal) => faults.recoverNativeProcesses(executionId, signal),
    })
    const connection = f.provider.connection.bind(f.provider)
    vi.spyOn(f.provider, 'connection').mockImplementation(() => faults.wrap(connection()))
    closes.push(f.close)
    await f.engine.start(f.f.run.id)
    const [first, sibling] = await f.pending()
    if (!first || !sibling) throw new Error('Expected both native waits')
    await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(first))
    const accepted = (await readCurrentExecutions(f.runs, f.f.run.id)).find((item) => item.id === first.executionId)!
    expect(accepted.result?.outcome).toBe('succeeded')
    const exact = await f.runs.getExecution(sibling.executionId!)
    faults.killOnRestart = true
    await f.engine.shutdown()
    const next = f.compose()
    await next.engine.resume(f.f.run.id)
    const resumed = await next.runs.get(f.f.run.id)
    expect({ state: resumed?.executionState, outcome: resumed?.outcome }).toEqual({ state: 'completed', outcome: 'failed' })
    expect(f.provider.closedSessions.has(sibling.nativeSessionId)).toBe(true)
    expect((await next.repository.get(sibling.id))?.status).toBe('canceled')
    expect((await next.runs.getExecution(sibling.executionId!))?.nativeSessionId).toBe(exact?.nativeSessionId)
    expect((await next.runs.getExecution(first.executionId!))?.result).toEqual(accepted.result)
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1 })
  }, 60000)

  it('authenticates the real launch credential and revokes it at Stop', async () => {
    const f = await fixture(), tokens: string[] = []
    const access = new PostgresAccessService(f.db.pool)
    const original = f.provider.createSession.bind(f.provider)
    vi.spyOn(f.provider, 'createSession').mockImplementation(async (input) => {
      const token = input.environment?.variables.GRAPHQL_MCP_TOKEN
      if (token) {
        await expect(access.authenticate(token, 'worker')).resolves.toMatchObject({ audience: 'worker' })
        tokens.push(token)
      }
      return original(input)
    })
    await f.engine.start(f.f.run.id)
    expect(tokens).toHaveLength(3)
    await f.stop(); await f.engine.cancel(f.f.run.id)
    await expect(access.authenticate(tokens[1]!, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  }, 60000)

  it('isolates a waiting branch while its sibling finishes and consumes each exact response once', async () => {
    const f = await fixture(), { compare } = await graphParity(f.db.pool, f.f.scope)
    await f.engine.start(f.f.run.id)
    const [first, sibling] = await f.pending()
    if (!first || !sibling) throw new Error('Expected parallel native requests')
    await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(first))
    expect((await compare()).state.run.pendingInteractionCount).toBe(1)
    expect((await f.repository.get(sibling.id))?.status).toBe('pending')
    const completed = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(sibling))
    expect((await compare()).state.run.outcome).toBe('succeeded')
    const receipts = await f.receipts()
    expect(receipts).toHaveLength(2)
    await f.engine.resumeInteraction(completed.interaction)
    await compare()
    expect(await f.receipts()).toEqual(receipts)
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 2 })
  }, 60000)
})
