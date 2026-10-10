import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type NativeHarnessEvent } from '@foreman-code/contracts'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteEntryClosureDigest, remoteNonEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import type { NativeHistory } from '../../harnesses/port.js'
import { pageNativeHistory } from './nativeHistoryPage.js'
import { RemoteNativeSessionManager, type RemoteNativeTransport, type RemoteNativeManagerOptions } from './nativeManagerProxy.js'

function event(sequence: number, text = 'event'): NativeHarnessEvent {
  return { sequence, type: 'native.notification', occurredAt: '2026-10-01T00:00:00.000Z', payload: { text } }
}
function setup(read: () => NativeHistory, changeReply?: (reply: ReturnType<typeof pageNativeHistory> & { status: { receipt: { sequence: number } } }) => void) {
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = {
    id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1, prompt: { system: 'test' },
    assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'fixture',
    createdAt: '2026-10-01T00:00:00.000Z',
  }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId,
      keyRevision: 1, authorizationRevision: 1 }, mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] },
  })
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent,
    connection: { mainId, deviceId, workerInstallationId, bootId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, connectionGeneration: 1 }, workerIncarnationId: randomUUID(), sequence: 1,
    phase: 'running', native: { sessionId: session.nativeSessionId, turnId: 'native-turn',
      processIdentityDigest: digest }, entryAttempted: true, turnEntryAttempted: true,
    turnInput: { correlationId: 'execution:execution', promptDigest: digest }, stopFence: false, controls: [],
  })
  const status = { status: 'known' as const, receipt }
  const cursors: Array<number | undefined> = []
  const observeOriginalSource = vi.fn<NonNullable<RemoteNativeManagerOptions['observeOriginalSource']>>(async () => {})
  const observedReceipts: Array<ReturnType<typeof RemoteOperationReceiptSchema.parse>> = []
  const request = vi.fn<RemoteNativeTransport['request']>(async (method, raw) => {
    const frame = RemoteExecutionRpcRequestSchema.parse(raw)
    if (method === 'prepare') return { session, status }
    if (method === 'start-turn') return status
    if (frame.method !== 'history') throw new Error('Unexpected request')
    cursors.push(frame.afterSequence)
    const reply = { ...pageNativeHistory(read(), frame.afterSequence, frame.metadata), status }
    changeReply?.(reply)
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(DEVICE_APPLICATION_JSON_BYTES)
    return reply
  })
  const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration,
    transport: { request }, observeReceipt: async value => { observedReceipts.push(value) }, observeOriginalSource,
    controlFor: async () => { throw new Error('No native control requested') },
  })
  const start = { correlationId: 'execution:execution', request: { executionId: 'execution', runId: 'run',
    workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/project', runtimeDirectory: '/runtime',
    configuration, input: {} } }
  return { proxy, start, request, cursors, observeOriginalSource, receipt, observedReceipts }
}

function terminal(events: NativeHarnessEvent[]): NativeHistory {
  const result = { outcome: 'succeeded' as const, output: { text: 'original terminal result' } }
  return { events, pendingInteractions: [], firstRetainedSequence: events[0]?.sequence ?? 0,
    nextSequence: (events.at(-1)?.sequence ?? -1) + 1, correlationId: 'execution:execution',
    nativeTurnId: 'native-turn', terminalResult: result,
    terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } }
}

describe('remote native history streaming', () => {
  it('carries the saved continuation into an authenticated preparation for the new execution', async () => {
    const f = setup(() => terminal([event(0)]))
    const sessionContinuation = { previousExecutionId: 'previous-execution', previousOperationId: 'previous-operation',
      session: { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'native-session' } }
    await f.proxy.createSession({ ...f.start, sessionContinuation })
    const frame = RemoteExecutionRpcRequestSchema.parse(f.request.mock.calls[0]![1])
    expect(frame).toMatchObject({ method: 'prepare', sessionContinuation,
      intent: { executionId: f.start.request.executionId }, request: f.start.request })
  })
  it('refreshes authenticated history before a slow consumer uses expired event observations', async () => {
    let now = Date.now()
    let observedAt = now
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const f = setup(() => {
        observedAt = now
        return terminal([event(0), event(1)])
      })
      f.observeOriginalSource.mockImplementation(async () => {
        if (now - observedAt >= 60_000) throw new Error('Original physical observation expired')
      })
      const session = await f.proxy.createSession(f.start)
      const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
      expect((await stream.next()).value).toEqual(event(0))
      now += 61_000
      expect((await stream.next()).value).toEqual(event(1))
      expect((await stream.next()).done).toBe(true)
      expect(f.cursors).toEqual([-1, 0])
      expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('refetches the remaining stream after a receipt refresh observes another history page', async () => {
    const events = Array.from({ length: 90 }, (_, sequence) => event(sequence, 'x'.repeat(20_000)))
    const available = new Map<number, Set<number>>()
    const f = setup(() => terminal(events), reply => {
      const sequence = reply.status.receipt.sequence
      const values = available.get(sequence) ?? new Set<number>()
      for (const event of reply.history.events) values.add(event.sequence)
      available.set(sequence, values)
    })
    f.observeOriginalSource.mockImplementation(async (receipt, source) => {
      if (source.type === 'event' && !available.get(receipt.sequence)?.has(source.event.sequence)) {
        throw new Error('This receipt has no original physical event observation')
      }
    })
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    const delivered: NativeHarnessEvent[] = []
    while (!f.cursors.some(cursor => cursor !== undefined && cursor >= 0)) {
      delivered.push((await stream.next()).value as NativeHarnessEvent)
    }
    f.receipt.sequence++
    const request = f.request.getMockImplementation()!
    f.request.mockImplementation((method, payload, signal) => method === 'status'
      ? Promise.resolve({ status: 'known', receipt: f.receipt }) : request(method, payload, signal))
    await f.proxy.observeBoundary(session)
    await f.proxy.history(session)
    for await (const event of stream) delivered.push(event)
    expect(delivered).toEqual(events)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })

  it.each(['entry', 'non-entry'] as const)('retains a closed %s receipt when preparation has no session acknowledgment', async kind => {
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    const original = { ...f.receipt }
    delete original.native
    delete original.turnInput
    const launchId = randomUUID()
    const entryClosure = { intent: original.intent, connection: original.connection, owner: 'execution:execution',
      initialLaunchId: launchId, launches: [{ owner: 'execution:execution', launchId,
        bootId: original.connection.bootId, lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const }] }
    const closed = RemoteOperationReceiptSchema.parse({ ...original,
      phase: 'confirmed_terminal', stopFence: true, turnEntryAttempted: false, entryAttempted: kind === 'entry',
      terminal: kind === 'entry' ? { kind: 'cancelled', entryClosure,
        closureEvidenceDigest: remoteEntryClosureDigest(entryClosure) }
        : { kind: 'not_started', closureEvidenceDigest: remoteNonEntryClosureDigest(original.intent) } })
    f.request.mockImplementation(async method => {
      if (method !== 'prepare') throw new Error('Closure does not create another native operation')
      return { status: { status: 'known', receipt: closed } }
    })
    await expect(f.proxy.createSession(f.start)).rejects.toMatchObject({
      result: { error: { code: 'REMOTE_PREPARATION_CLOSED' } },
    })
    expect(f.observedReceipts).toEqual([closed])
    expect(f.observeOriginalSource).not.toHaveBeenCalled()
    await expect(f.proxy.dispose()).resolves.toBeUndefined()
    expect(f.request).toHaveBeenCalledTimes(1)
  })

  it('reports a gap when a delayed consumer falls behind the retained window, before yielding its newer events', async () => {
    let history: NativeHistory = { events: [event(0)], pendingInteractions: [], firstRetainedSequence: 0,
      nextSequence: 1 }
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    expect((await stream.next()).value).toEqual(event(0))
    // The worker advances while the consumer is suspended at the prior yield.
    history = terminal([event(50), event(51)])
    await expect(stream.next()).rejects.toMatchObject({ result: { error: { code: 'NATIVE_HISTORY_GAP' } } })
    expect(f.cursors).toEqual([-1, 0])
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
    expect((await f.proxy.reconcile(session, f.start.correlationId)).terminalTurn).toEqual(history.terminalTurn)
  })

  it('checks the retained floor even when the worker omits its explicit gap flag', async () => {
    const f = setup(() => terminal([event(50)]), reply => { delete reply.history.gap })
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    await expect(stream.next()).rejects.toMatchObject({ result: { error: { code: 'NATIVE_HISTORY_GAP' } } })
    expect(f.cursors).toEqual([-1])
  })

  it('does not advance across a missing sequence inside a terminal page', async () => {
    const f = setup(() => terminal([event(0), event(2)]))
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    expect((await stream.next()).value).toEqual(event(0))
    await expect(stream.next()).rejects.toMatchObject({ result: { error: { code: 'NATIVE_HISTORY_GAP' } } })
    expect(f.cursors).toEqual([-1])
  })

  it('still ignores duplicate sequences in overlapping pages', async () => {
    let history: NativeHistory = { events: [event(0)], pendingInteractions: [], firstRetainedSequence: 0,
      nextSequence: 1 }
    const f = setup(() => history, reply => {
      if (reply.history.events[0]?.sequence === 1) reply.history.events = [event(0), ...reply.history.events]
    })
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    expect((await stream.next()).value).toEqual(event(0))
    history = terminal([event(0), event(1), event(2)])
    expect((await stream.next()).value).toEqual(event(1))
    expect((await stream.next()).value).toEqual(event(2))
    expect((await stream.next()).done).toBe(true)
    expect(f.cursors).toEqual([-1, 0])
  })

  it.each(['cursor', 'remaining', 'stalled'] as const)('rejects a discontinuous %s continuation', async defect => {
    const f = setup(() => terminal([event(0)]), reply => {
      if (defect === 'cursor') reply.page.nextAfterSequence = 10
      if (defect === 'remaining') reply.page.hasMore = true
      if (defect === 'stalled') {
        reply.history.events = []
        reply.page.nextAfterSequence = -1
        reply.page.hasMore = true
      }
    })
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    if (defect !== 'stalled') expect((await stream.next()).value).toEqual(event(0))
    await expect(stream.next()).rejects.toMatchObject({ result: { error: { code: 'NATIVE_HISTORY_GAP' } } })
    expect(f.cursors).toEqual([-1])
  })

  it('drains every continuation before returning a terminal turn and recovers the original result', async () => {
    const events = Array.from({ length: 90 }, (_, sequence) => event(sequence, 'x'.repeat(20_000)))
    const history = terminal(events)
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(DEVICE_APPLICATION_JSON_BYTES)
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const delivered: NativeHarnessEvent[] = []
    for await (const value of f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })) {
      delivered.push(value)
      expect((await f.proxy.history(session)).terminalTurn).toEqual(history.terminalTurn)
    }
    expect(delivered).toEqual(events)
    expect(f.cursors[0]).toBe(-1)
    expect(f.cursors.length).toBeGreaterThan(1)
    expect(f.cursors.every(cursor => cursor !== undefined)).toBe(true)
    const recovered = await f.proxy.reconcile(session, f.start.correlationId)
    expect(recovered.terminalTurn).toEqual(history.terminalTurn)
    expect(recovered.firstRetainedSequence).toBeGreaterThan(0)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })

  it('exposes an oversized event gap without blocking subsequent terminal recovery or replaying the turn', async () => {
    const history = terminal([event(0, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1))])
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    await expect(stream.next()).rejects.toMatchObject({ result: { error: { code: 'NATIVE_HISTORY_GAP' } } })
    const recovered = await f.proxy.reconcile(session, f.start.correlationId)
    expect(recovered.events).toEqual([])
    expect(recovered.gap).toEqual({ fromSequence: 0, toSequence: 0, reason: 'event_too_large' })
    expect(recovered.terminalTurn).toEqual(history.terminalTurn)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })
  it('streams and reconciles terminal answers larger than a history page using the original result', async () => {
    const history = terminal([event(0)])
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(65_536) } }
    history.terminalResult = result
    history.terminalTurn!.result = result
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    expect((await stream.next()).value).toEqual(event(0))
    expect((await stream.next()).done).toBe(true)
    expect((await f.proxy.reconcile(session, f.start.correlationId)).terminalTurn).toEqual(history.terminalTurn)
    expect((await f.proxy.history(session)).terminalResult).toEqual(result)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
    expect(f.request.mock.calls.filter(([, raw]) => 'metadata' in (raw as object)).length).toBeGreaterThan(1)
  })
  it('reconstructs duplicate near-three-MiB results through the proxy without another native turn', async () => {
    const history = terminal([event(0)])
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(450_000) } }
    history.terminalResult = result
    history.terminalTurn!.result = result
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    expect((await stream.next()).value).toEqual(event(0))
    expect((await stream.next()).done).toBe(true)
    const recovered = await f.proxy.reconcile(session, f.start.correlationId)
    expect(recovered.terminalResult).toEqual(result)
    expect(recovered.terminalTurn?.result).toEqual(result)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })
})
