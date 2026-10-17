import { randomUUID } from 'node:crypto'
import { deferred } from '../../../../test/helpers/deferred.js'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type NativeHarnessEvent } from '@foreman-code/contracts'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import type { DeviceHistoryGap } from '@foreman-code/contracts/device-application'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteEntryClosureDigest, remoteNonEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import type { NativeHistory } from '../../harnesses/port.js'
import { pageNativeHistory } from './nativeHistoryPage.js'
import { RemoteNativeSessionManager, type RemoteNativeTransport, type RemoteNativeManagerOptions } from './nativeManagerProxy.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { DomainError } from '../../errors.js'

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
  const discardedReceipts: Array<ReturnType<typeof RemoteOperationReceiptSchema.parse>> = []
  const controlFor = vi.fn<RemoteNativeManagerOptions['controlFor']>(async () => {
    throw new Error('No native control requested')
  })
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
    transport: { request }, observeReceipt: async value => { observedReceipts.push(value) },
    discardReceipt: value => { discardedReceipts.push(value) }, observeOriginalSource,
    controlFor,
  })
  const start = { correlationId: 'execution:execution', request: { executionId: 'execution', runId: 'run',
    workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/project', runtimeDirectory: '/runtime',
    configuration, input: {} } }
  return { proxy, start, request, cursors, controlFor, observeOriginalSource, receipt, observedReceipts, discardedReceipts }
}

function terminal(events: NativeHarnessEvent[]): NativeHistory {
  const result = { outcome: 'succeeded' as const, output: { text: 'original terminal result' } }
  return { events, pendingInteractions: [], firstRetainedSequence: events[0]?.sequence ?? 0,
    nextSequence: (events.at(-1)?.sequence ?? -1) + 1, correlationId: 'execution:execution',
    nativeTurnId: 'native-turn', terminalResult: result,
    terminalTurn: { correlationId: 'execution:execution', providerId: 'native-turn', result } }
}

describe('remote native history streaming', () => {
  it.each(['history', 'stream'] as const)(
    'pins the %s snapshot while reviewer renewal overtakes metadata pages', async operation => {
      const history = terminal([event(0)])
      const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(65_536) } }
      history.terminalResult = result
      history.terminalTurn!.result = result
      const f = setup(() => history)
      f.receipt.retainedReviewer = { agentId: 'agent', workflowTurnId: 'native-turn', result,
        expiresAt: '2099-01-01T00:00:00.000Z' }
      const entered = deferred()
      const release = deferred()
      const request = f.request.getMockImplementation()!
      let delayed = false
      f.request.mockImplementation(async (method, raw, signal) => {
        const frame = RemoteExecutionRpcRequestSchema.parse(raw)
        if (frame.method === 'history' && frame.metadata && !delayed) {
          delayed = true
          entered.resolve()
          await release.promise
        }
        return structuredClone(await request(method, raw, signal))
      })
      const session = await f.proxy.createSession(f.start)
      const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
      const reading = operation === 'history' ? f.proxy.history(session) : stream.next()
      const outcome = Promise.allSettled([reading])
      try {
        await entered.promise
        f.receipt.sequence++
        f.receipt.retainedReviewer.expiresAt = '2099-01-01T00:01:00.000Z'
      } finally {
        release.resolve()
      }
      await outcome
      if (operation === 'history') {
        expect(await reading).toMatchObject({ terminalResult: result, terminalTurn: history.terminalTurn })
      } else {
        expect(await reading).toEqual({ done: false, value: event(0) })
        expect((await stream.next()).done).toBe(true)
      }
      const historyRequests = f.request.mock.calls.map(([, raw]) => RemoteExecutionRpcRequestSchema.parse(raw))
        .filter(frame => frame.method === 'history')
      expect(historyRequests.filter(frame => !frame.metadata)).toHaveLength(1)
      expect(f.observedReceipts.every(receipt => receipt.sequence === 1)).toBe(true)
      expect(f.controlFor).not.toHaveBeenCalled()
    })

  it.each(['history', 'stream'] as const)(
    'refetches an overtaken %s response after a newer boundary observation', async operation => {
      const history = terminal([event(0), event(1)])
      const f = setup(() => history)
      const request = f.request.getMockImplementation()!
      const entered = deferred()
      const release = deferred()
      let delayed = false
      f.request.mockImplementation(async (method, raw, signal) => {
        if (method === 'status') return { status: 'known', receipt: structuredClone(f.receipt) }
        const reply = structuredClone(await request(method, raw, signal))
        if (method === 'history' && !delayed) {
          delayed = true
          entered.resolve()
          await release.promise
        }
        return reply
      })
      const session = await f.proxy.createSession(f.start)
      const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
      const reading = operation === 'history' ? f.proxy.history(session) : stream.next()
      const outcome = Promise.allSettled([reading])
      try {
        await entered.promise
        f.receipt.sequence++
        await f.proxy.observeBoundary(session)
      } finally {
        release.resolve()
      }
      await outcome
      if (operation === 'history') {
        expect(await reading).toEqual(history)
      } else {
        expect(await reading).toEqual({ done: false, value: event(0) })
        expect(await stream.next()).toEqual({ done: false, value: event(1) })
        expect((await stream.next()).done).toBe(true)
      }
      expect(f.request.mock.calls.filter(([method]) => method === 'history')).toHaveLength(2)
      expect(f.observedReceipts.map(receipt => receipt.sequence)).toEqual([1, 1, 2, 2].slice(
        operation === 'history' ? 1 : 0))
      expect(f.discardedReceipts.map(receipt => receipt.sequence)).toEqual([1])
      expect(f.controlFor).not.toHaveBeenCalled()
    })

  it.each(['history', 'stream'] as const)(
    'rejects %s sequence drift below the receipt known before dispatch', async operation => {
      const f = setup(() => terminal([event(0)]))
      f.receipt.sequence = 3
      const request = f.request.getMockImplementation()!
      f.request.mockImplementation(async (method, raw, signal) => {
        const reply = structuredClone(await request(method, raw, signal))
        if (method === 'history') {
          const value = reply as { status: { receipt: typeof f.receipt } }
          value.status.receipt.sequence--
        }
        return reply
      })
      const session = await f.proxy.createSession(f.start)
      const reading = operation === 'history' ? f.proxy.history(session) : f.proxy.startTurn(session, {
        prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      }).next()
      await expect(reading).rejects.toThrow('Original remote receipt changed')
      expect(f.request.mock.calls.filter(([method]) => method === 'history')).toHaveLength(1)
      expect(f.observedReceipts.map(receipt => receipt.sequence)).toEqual(
        operation === 'history' ? [3] : [3, 3])
      expect(f.controlFor).not.toHaveBeenCalled()
    })

  it.each(['session', 'process', 'connection', 'incarnation', 'intent', 'same-revision'] as const)(
    'rejects an overtaken history response with a conflicting %s', async conflict => {
      const f = setup(() => terminal([event(0)]))
      const request = f.request.getMockImplementation()!
      const entered = deferred()
      const release = deferred()
      f.request.mockImplementation(async (method, raw, signal) => {
        if (method === 'status') return { status: 'known', receipt: structuredClone(f.receipt) }
        const reply = structuredClone(await request(method, raw, signal))
        if (method === 'history') {
          const value = reply as { status: { receipt: typeof f.receipt } }
          const receipt = value.status.receipt
          if (conflict === 'session') receipt.native!.sessionId = 'foreign-session'
          if (conflict === 'process') receipt.native!.processIdentityDigest = 'b'.repeat(64)
          if (conflict === 'connection') receipt.connection.bootId = randomUUID()
          if (conflict === 'incarnation') receipt.workerIncarnationId = randomUUID()
          if (conflict === 'intent') receipt.intent.attemptId = 'foreign-attempt'
          if (conflict === 'same-revision') receipt.stopFence = true
          entered.resolve()
          await release.promise
        }
        return reply
      })
      const session = await f.proxy.createSession(f.start)
      const reading = f.proxy.history(session)
      const outcome = Promise.allSettled([reading])
      try {
        await entered.promise
        if (conflict !== 'same-revision') f.receipt.sequence++
        await f.proxy.observeBoundary(session)
      } finally {
        release.resolve()
      }
      await outcome
      await expect(reading).rejects.toThrow(conflict === 'intent'
        ? 'Remote receipt binding mismatch' : 'Original remote receipt changed')
      expect(f.request.mock.calls.filter(([method]) => method === 'history')).toHaveLength(1)
    })

  it('refreshes an expired physical reply without skipping events or starting another native turn', async () => {
    const f = setup(() => terminal([event(0), event(1)]))
    const session = await f.proxy.createSession(f.start)
    f.observeOriginalSource.mockRejectedValueOnce(new DeviceApplicationError('REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED'))
    const delivered: NativeHarnessEvent[] = []
    for await (const frame of f.proxy.startTurn(session, {
      prompt: 'prompt', clientCorrelationId: f.start.correlationId,
    })) delivered.push(frame)
    expect(delivered).toEqual([event(0), event(1)])
    expect(f.cursors).toEqual([-1, -1])
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'start-turn', 'history', 'history'])
    expect(f.controlFor).not.toHaveBeenCalled()
  })

  it('refreshes history from the same native session after its physical reply expires', async () => {
    const history = terminal([event(0)])
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    f.observeOriginalSource.mockRejectedValueOnce(new DeviceApplicationError('REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED'))
    expect((await f.proxy.history(session)).events).toEqual(history.events)
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'history', 'history'])
    expect(f.observedReceipts.every(receipt => receipt.intent.attemptId === f.receipt.intent.attemptId)).toBe(true)
    expect(f.controlFor).not.toHaveBeenCalled()
  })

  it('still fails physical identity errors without refreshing the original source', async () => {
    const f = setup(() => terminal([event(0)]))
    const session = await f.proxy.createSession(f.start)
    const failure = new DeviceApplicationError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE')
    f.observeOriginalSource.mockRejectedValueOnce(failure)
    await expect(f.proxy.history(session)).rejects.toBe(failure)
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'history'])
  })

  it.each(['history', 'stream'] as const)('bounds physical reply refreshes during %s reads', async operation => {
    const f = setup(() => terminal([event(0)]))
    const session = await f.proxy.createSession(f.start)
    const failure = new DeviceApplicationError('REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED')
    f.observeOriginalSource.mockRejectedValue(failure)
    const read = operation === 'history' ? f.proxy.history(session) : f.proxy.startTurn(session, {
      prompt: 'prompt', clientCorrelationId: f.start.correlationId,
    }).next()
    await expect(read).rejects.toBe(failure)
    expect(f.request.mock.calls.filter(([method]) => method === 'history')).toHaveLength(5)
    expect(f.controlFor).not.toHaveBeenCalled()
  })

  it.each(['close', 'closeForRestart'] as const)('cancels the device request when %s reaches its deadline', async method => {
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    const session = await f.proxy.createSession(f.start)
    let enteredSignal: AbortSignal | undefined
    f.request.mockImplementation(async (_method, _payload, signal) => {
      enteredSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const controller = new AbortController()
    const error = new Error('Cleanup deadline reached')
    const close = f.proxy[method] as (reference: typeof session, signal?: AbortSignal) => Promise<void>
    const result = close.call(f.proxy, session, controller.signal).catch((failure: unknown) => failure)
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2))
    expect(enteredSignal).toBe(controller.signal)
    controller.abort(error)
    expect(await result).toBe(error)
  })

  it('accepts journaled capacity retries after observing the original native turn', async () => {
    const f = setup(() => ({ events: [], pendingInteractions: [], nativeTurnId: 'retry-turn' }))
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, payload, signal) => {
      const reply = await original(method, payload, signal)
      return structuredClone(reply)
    })
    const session = await f.proxy.createSession(f.start)
    f.receipt.native!.turnId = 'retry-turn'
    Object.assign(f.receipt, { nativeTurnRetries: [{ previousTurnId: 'native-turn', turnId: 'retry-turn' }] })
    f.receipt.sequence++
    await expect(f.proxy.history(session)).resolves.toMatchObject({ nativeTurnId: 'retry-turn' })
    f.receipt.native!.turnId = 'foreign-turn'
    f.receipt.sequence++
    await expect(f.proxy.history(session)).rejects.toThrow()
  })

  it('passes the caller lifetime to original-source observation', async () => {
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    const controller = new AbortController()
    await f.proxy.createSession(f.start, controller.signal)
    const observedSignal = f.observeOriginalSource.mock.calls[0]?.[2]
    expect(observedSignal).toBeDefined()
    controller.abort(new Error('Execution stopped'))
    expect(observedSignal?.aborted).toBe(true)
  })

  it('disposes a failed startup by stopping its accepted operation without inventing a native session', async () => {
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    delete f.receipt.native
    delete f.receipt.turnInput
    f.receipt.entryAttempted = false
    f.receipt.turnEntryAttempted = false
    f.receipt.phase = 'received'
    f.request.mockImplementation(async (method, payload) => {
      if (method === 'prepare') throw new Error('Preparation failed before native entry')
      if (method === 'control') {
        const frame = RemoteExecutionRpcRequestSchema.parse(payload)
        if (frame.method !== 'control') throw new Error('Expected Stop')
        expect(frame.command.native).toBeUndefined()
        expect(frame.command.action).toEqual({ kind: 'stop' })
        f.receipt.controls.push(frame.command)
        f.receipt.sequence++
        f.receipt.stopFence = true
        f.receipt.phase = 'confirmed_terminal'
        f.receipt.terminal = { kind: 'not_started',
          closureEvidenceDigest: remoteNonEntryClosureDigest(f.receipt.intent) }
      }
      return { status: 'known', receipt: structuredClone(f.receipt) }
    })
    await expect(f.proxy.createSession(f.start)).rejects.toThrow('Preparation failed before native entry')
    await expect(f.proxy.dispose()).resolves.toBeUndefined()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'status', 'control'])
    expect(f.controlFor).not.toHaveBeenCalled()
    await f.proxy.dispose()
    expect(f.request).toHaveBeenCalledTimes(3)
  })

  it.each(['backpressure', 'timeout'])('retries %s during preparation with the same start identity', async code => {
    vi.useFakeTimers()
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    f.request.mockRejectedValueOnce(new DeviceApplicationError(code))
    try {
      const result = f.proxy.createSession(f.start)
      const checked = expect(result).resolves.toMatchObject({ nativeSessionId: 'native-session' })
      await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(5_000)])
      await checked
      expect(f.request).toHaveBeenCalledTimes(2)
      expect(f.request.mock.calls[1]).toEqual(f.request.mock.calls[0])
      expect(f.observedReceipts).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('bounds preparation retries and cancels queued retries before another start', async () => {
    vi.useFakeTimers()
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    f.request.mockRejectedValue(new DeviceApplicationError('backpressure'))
    try {
      const checked = expect(f.proxy.createSession(f.start)).rejects.toMatchObject({ code: 'backpressure' })
      await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(10_000)])
      await checked
      expect(f.request.mock.calls.length).toBeGreaterThan(1)
      expect(f.request.mock.calls.length).toBeLessThanOrEqual(6)
      f.request.mockClear()
      const controller = new AbortController()
      const cancelled = expect(f.proxy.createSession(f.start, controller.signal)).rejects.toThrow('Stopped')
      await vi.advanceTimersByTimeAsync(1)
      controller.abort(new Error('Stopped'))
      await vi.advanceTimersByTimeAsync(10_000)
      await cancelled
      expect(f.request).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('publishes retry identities in event order when a reader sees several native attempts at once', async () => {
    const correlation = 'execution:execution'
    const events = [
      { ...event(0), type: 'turn.started', payload: { threadId: 'native-session', turnId: 'first-turn', clientCorrelationId: correlation } },
      { ...event(1), type: 'turn.completed', payload: { threadId: 'native-session', turnId: 'first-turn', status: 'failed', willRetry: true } },
      { ...event(2), type: 'turn.capacity_retry', payload: { threadId: 'native-session', turnId: 'first-turn' } },
      { ...event(3), type: 'turn.started', payload: { threadId: 'native-session', turnId: 'native-turn', clientCorrelationId: correlation } },
    ]
    const f = setup(() => terminal(events))
    const session = await f.proxy.createSession(f.start)
    const identities: string[] = []
    const delivered: NativeHarnessEvent[] = []
    for await (const frame of f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: correlation,
      onSubmitted: async id => { identities.push(`submitted:${id}`) },
      onRetry: async id => { identities.push(`retry:${id}`) },
    })) delivered.push(frame)
    expect(identities).toEqual(['submitted:first-turn', 'retry:first-turn', 'submitted:native-turn'])
    expect(delivered).toEqual(events)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })
  it('refreshes a recovered turn acknowledgment before admitting Stop', async () => {
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    const running = structuredClone(f.receipt)
    delete f.receipt.native!.turnId
    delete f.receipt.turnInput
    f.receipt.phase = 'start_acknowledged'
    f.receipt.turnEntryAttempted = false
    const session = await f.proxy.createSession(f.start)
    Object.assign(f.receipt, running, { sequence: running.sequence + 1 })
    f.controlFor.mockImplementation(async input => ({
      schemaVersion: 1, protocolVersion: 1, commandId: randomUUID(),
      operationId: f.receipt.intent.operationId, attemptId: f.receipt.intent.attemptId,
      executionId: f.receipt.intent.executionId, bindingHash: f.receipt.intent.bindingHash,
      owner: f.receipt.intent.owner, native: input.native, action: { kind: 'stop' },
    }))
    const request = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, payload, signal) => {
      if (method === 'status') return { status: 'known', receipt: f.receipt }
      if (method !== 'control') return request(method, payload, signal)
      const frame = RemoteExecutionRpcRequestSchema.parse(payload)
      if (frame.method !== 'control') throw new Error('Expected a native control.')
      expect(frame.command.native).toEqual(running.native)
      f.receipt.controls.push(frame.command)
      f.receipt.stopFence = true
      f.receipt.phase = 'confirmed_terminal'
      f.receipt.terminal = { kind: 'cancelled', closureEvidenceDigest: 'b'.repeat(64) }
      f.receipt.sequence++
      return { status: 'known', receipt: f.receipt }
    })

    await expect(f.proxy.cancel(session)).resolves.toBe(true)
    expect(f.controlFor).toHaveBeenCalledWith({ kind: 'stop', native: running.native })
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'status', 'control', 'history'])
  })

  it('reads a recovered terminal closure without admitting another Stop', async () => {
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    const session = await f.proxy.createSession(f.start)
    f.receipt.phase = 'confirmed_terminal'
    f.receipt.stopFence = true
    f.receipt.terminal = { kind: 'cancelled', closureEvidenceDigest: 'b'.repeat(64) }
    f.receipt.sequence++
    const request = f.request.getMockImplementation()!
    f.request.mockImplementation((method, payload, signal) => method === 'status'
      ? Promise.resolve({ status: 'known', receipt: f.receipt }) : request(method, payload, signal))

    await expect(f.proxy.cancel(session)).resolves.toBe(true)
    expect(f.controlFor).not.toHaveBeenCalled()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'status', 'history'])
  })

  it('refuses Stop when refreshed native ownership differs from the original session', async () => {
    const f = setup(() => ({ events: [], pendingInteractions: [] }))
    const session = await f.proxy.createSession(f.start)
    f.receipt.native!.sessionId = 'replacement-session'
    f.receipt.sequence++
    f.request.mockImplementation(async () => ({ status: 'known', receipt: f.receipt }))

    await expect(f.proxy.cancel(session)).rejects.toThrow('Original remote receipt changed')
    expect(f.controlFor).not.toHaveBeenCalled()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'status'])
  })

  it.each(['prepare', 'reattach'] as const)('preserves restart cancellation during %s before acknowledgment', async mode => {
    const f = setup(() => terminal([event(0)]))
    const controller = new AbortController()
    const restart = new DomainError('ENGINE_RESTART', 'Main is restarting.', 409)
    let requesting!: () => void
    const entered = new Promise<void>(resolve => { requesting = resolve })
    f.request.mockImplementation((_method, _payload, signal) => {
      requesting()
      return new Promise<never>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DeviceApplicationError('cancelled')), { once: true })
      })
    })
    const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
    const opening = mode === 'prepare'
      ? f.proxy.createSession(f.start, controller.signal)
      : f.proxy.attachSession(session, f.start, controller.signal)
    const canceled = expect(opening).rejects.toBe(restart)
    await entered
    controller.abort(restart)
    await canceled
    expect(f.observedReceipts).toEqual([])
    expect(f.observeOriginalSource).not.toHaveBeenCalled()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([mode])
  })

  it('refreshes the original closure receipt before canceling a retained session', async () => {
    const f = setup(() => terminal([event(0)]))
    const session = await f.proxy.createSession(f.start)
    const closed = RemoteOperationReceiptSchema.parse({ ...f.receipt, sequence: f.receipt.sequence + 1,
      phase: 'confirmed_terminal', stopFence: true,
      terminal: { kind: 'cancelled', closureEvidenceDigest: 'b'.repeat(64) } })
    f.request.mockImplementation(async (method, raw) => {
      expect(RemoteExecutionRpcRequestSchema.parse(raw)).toMatchObject({ method: 'status',
        intent: f.receipt.intent })
      if (method !== 'status') throw new Error('Only closure readback is expected')
      return { status: 'known', receipt: closed }
    })
    await f.proxy.close(session)
    await f.proxy.dispose()
    expect(f.observedReceipts.at(-1)).toEqual(closed)
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'status'])
  })

  it('preserves restart cancellation during remote observation and detaches the same session', async () => {
    const f = setup(() => ({
      events: [], pendingInteractions: [], correlationId: 'execution:execution', nativeTurnId: 'native-turn',
    }))
    const session = await f.proxy.createSession(f.start)
    const controller = new AbortController()
    const restart = new DomainError('ENGINE_RESTART', 'Main is restarting.', 409)
    const request = f.request.getMockImplementation()!
    let observing!: () => void
    const entered = new Promise<void>(resolve => { observing = resolve })
    f.request.mockImplementation((method, payload, signal) => {
      if (method !== 'history' || signal !== controller.signal) return request(method, payload, signal)
      observing()
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DeviceApplicationError('cancelled')), { once: true })
      })
    })
    const observation = f.proxy.history(session, controller.signal)
    const canceled = expect(observation).rejects.toBe(restart)
    await entered
    controller.abort(restart)
    await canceled

    await f.proxy.closeForRestart(session)
    await f.proxy.dispose()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['prepare', 'history', 'history'])
    expect(f.receipt.stopFence).toBe(false)
    expect(f.receipt.terminal).toBeUndefined()
    expect(f.observedReceipts.every(receipt => receipt.native?.sessionId === session.nativeSessionId)).toBe(true)
  })

  it.each(['cancelled', 'transport', 'REMOTE_AUTHORITY_DENIED'])(
    'keeps an independent %s failure when the caller has not canceled the request', async code => {
      const f = setup(() => terminal([event(0)]))
      const error = new DeviceApplicationError(code)
      f.request.mockRejectedValue(error)
      await expect(f.proxy.createSession(f.start, new AbortController().signal)).rejects.toBe(error)
    },
  )

  it('does not hide a transport failure behind a concurrent restart', async () => {
    const f = setup(() => terminal([event(0)]))
    const controller = new AbortController()
    const error = new DeviceApplicationError('transport')
    f.request.mockImplementation(async () => {
      controller.abort(new DomainError('ENGINE_RESTART', 'Main is restarting.', 409))
      throw error
    })
    await expect(f.proxy.createSession(f.start, controller.signal)).rejects.toBe(error)
  })

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

  it('resumes a delayed consumer after retention and preserves the correlated terminal result', async () => {
    let history: NativeHistory = { events: [event(0)], pendingInteractions: [], firstRetainedSequence: 0,
      nextSequence: 1 }
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const skipped: DeviceHistoryGap[] = []
    const input = { prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      onEventsSkipped: async (gap: DeviceHistoryGap) => { skipped.push(gap) } }
    const stream = f.proxy.startTurn(session, input)
    expect((await stream.next()).value).toEqual(event(0))
    // The worker advances while the consumer is suspended at the prior yield.
    history = terminal([event(50), event(51)])
    expect((await stream.next()).value).toEqual(event(50))
    expect((await stream.next()).value).toEqual(event(51))
    expect((await stream.next()).done).toBe(true)
    expect(skipped).toEqual([{ fromSequence: 1, toSequence: 49, reason: 'retention' }])
    expect(f.cursors).toEqual([-1, 0])
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
    expect((await f.proxy.reconcile(session, f.start.correlationId)).terminalTurn).toEqual(history.terminalTurn)
  })

  it.each(['succeeded', 'failed', 'canceled'] as const)(
    'preserves the original %s result after events were trimmed before the first read', async outcome => {
    const history = terminal([event(50)])
    const result = { outcome, output: { text: 'saved result' },
      ...(outcome === 'failed' ? { error: { code: 'PROVIDER_FAILED', message: 'Provider failed', retryable: false } } : {}) }
    history.terminalResult = result
    history.terminalTurn!.result = result
    const f = setup(() => history, reply => { delete reply.history.gap })
    const session = await f.proxy.createSession(f.start)
    const skipped: DeviceHistoryGap[] = []
    const input = { prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      onEventsSkipped: async (gap: DeviceHistoryGap) => { skipped.push(gap) } }
    const delivered: NativeHarnessEvent[] = []
    for await (const value of f.proxy.startTurn(session, input)) delivered.push(value)
    expect(delivered).toEqual([event(50)])
    expect(skipped).toEqual([{ fromSequence: 0, toSequence: 49, reason: 'retention' }])
    expect((await f.proxy.reconcile(session, f.start.correlationId)).terminalTurn?.result).toEqual(result)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })

  it('refreshes an aged page and resumes when retention advances during publication', async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let history = terminal([event(0), event(1)])
      const f = setup(() => history)
      const session = await f.proxy.createSession(f.start)
      const skipped: DeviceHistoryGap[] = []
      const input = { prompt: 'prompt', clientCorrelationId: f.start.correlationId,
        onEventsSkipped: async (gap: DeviceHistoryGap) => { skipped.push(gap) } }
      const stream = f.proxy.startTurn(session, input)
      expect((await stream.next()).value).toEqual(event(0))
      now += 30_001
      history = terminal([event(50)])
      expect((await stream.next()).value).toEqual(event(50))
      expect((await stream.next()).done).toBe(true)
      expect(skipped).toEqual([{ fromSequence: 1, toSequence: 49, reason: 'retention' }])
      expect(f.cursors).toEqual([-1, 0])
    } finally { clock.mockRestore() }
  })

  it.each(['correlation', 'turn', 'session'] as const)('rejects foreign %s history even after retention', async defect => {
    const f = setup(() => terminal([event(50)]), reply => { delete reply.history.gap })
    const session = await f.proxy.createSession(f.start)
    const request = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, payload, signal) => {
      const reply = await request(method, payload, signal)
      if (method !== 'history') return reply
      const value = reply as ReturnType<typeof pageNativeHistory>
      if (defect === 'correlation') value.history.terminalTurn!.correlationId = 'foreign-correlation'
      if (defect === 'turn') value.history.terminalTurn!.providerId = 'foreign-turn'
      if (defect === 'session') value.history.nativeSubmission = { kind: 'message',
        nativeSessionId: 'foreign-session', nativeMessageId: 'native-message', clientCorrelationId: f.start.correlationId }
      return reply
    })
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    await expect(stream.next()).rejects.toThrow()
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

  it('reads the terminal result when the Worker retained no events', async () => {
    const history = { ...terminal([]), firstRetainedSequence: 50, nextSequence: 50 }
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const skipped: DeviceHistoryGap[] = []
    const input = { prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      onEventsSkipped: async (gap: DeviceHistoryGap) => { skipped.push(gap) } }
    const stream = f.proxy.startTurn(session, input)
    expect((await stream.next()).done).toBe(true)
    expect(skipped).toEqual([{ fromSequence: 0, toSequence: 49, reason: 'retention' }])
    expect((await f.proxy.reconcile(session, f.start.correlationId)).terminalTurn?.result).toEqual(history.terminalResult)
  })

  it('rejects a terminal result that differs from the saved Worker result', async () => {
    const f = setup(() => terminal([event(50)]))
    const session = await f.proxy.createSession(f.start)
    f.receipt.phase = 'confirmed_terminal'
    f.receipt.terminal = { kind: 'completed', closureEvidenceDigest: 'b'.repeat(64),
      result: { outcome: 'failed', error: { code: 'PROVIDER_FAILURE', message: 'Original failure', retryable: false } } }
    const stream = f.proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: f.start.correlationId })
    await expect(stream.next()).rejects.toThrow()
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

  it('skips an oversized event without blocking terminal recovery or replaying the turn', async () => {
    const history = terminal([event(0, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1))])
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const skipped: DeviceHistoryGap[] = []
    const input = { prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      onEventsSkipped: async (gap: DeviceHistoryGap) => { skipped.push(gap) } }
    const stream = f.proxy.startTurn(session, input)
    expect((await stream.next()).done).toBe(true)
    expect(skipped).toEqual([{ fromSequence: 0, toSequence: 0, reason: 'event_too_large' }])
    const recovered = await f.proxy.reconcile(session, f.start.correlationId)
    expect(recovered.events).toEqual([])
    expect(recovered.gap).toEqual({ fromSequence: 0, toSequence: 0, reason: 'event_too_large' })
    expect(recovered.terminalTurn).toEqual(history.terminalTurn)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })
  it('continues past retention followed by an oversized event without losing later events or the result', async () => {
    const initial = Array.from({ length: 147 }, (_, sequence) => event(sequence))
    let history: NativeHistory = {
      events: initial, pendingInteractions: [], firstRetainedSequence: 0, nextSequence: 147,
    }
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const skipped: DeviceHistoryGap[] = []
    const stream = f.proxy.startTurn(session, {
      prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      onEventsSkipped: async gap => { skipped.push(gap) },
    })
    for (const frame of initial) expect((await stream.next()).value).toEqual(frame)

    history = terminal([event(442, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1)), event(443)])
    expect((await stream.next()).value).toEqual(event(443))
    expect((await stream.next()).done).toBe(true)
    expect(skipped).toEqual([
      { fromSequence: 147, toSequence: 441, reason: 'retention' },
      { fromSequence: 442, toSequence: 442, reason: 'event_too_large' },
    ])
    expect(f.cursors).toEqual([-1, 146, 441, 442])
    expect((await f.proxy.reconcile(session, f.start.correlationId)).terminalTurn).toEqual(history.terminalTurn)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })

  it.each([0, 1, 2, 3])('drains protected terminal snapshots across oversized event mask %i', async mask => {
    const protectedEvent = event(10, mask & 1 ? 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1) : 'protected')
    const retainedEvent = event(50, mask & 2 ? 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1) : 'retained')
    const history: NativeHistory = {
      ...terminal([protectedEvent, retainedEvent]),
      gap: { fromSequence: 11, toSequence: 49, reason: 'retention' },
    }
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const skipped: DeviceHistoryGap[] = []
    const delivered: NativeHarnessEvent[] = []
    for await (const frame of f.proxy.startTurn(session, {
      prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      onEventsSkipped: async gap => { skipped.push(gap) },
    })) delivered.push(frame)
    const expectedGaps: DeviceHistoryGap[] = [{ fromSequence: 0, toSequence: 9, reason: 'retention' }]
    if (mask & 1) expectedGaps.push({ fromSequence: 10, toSequence: 10, reason: 'event_too_large' })
    expectedGaps.push({ fromSequence: 11, toSequence: 49, reason: 'retention' })
    if (mask & 2) expectedGaps.push({ fromSequence: 50, toSequence: 50, reason: 'event_too_large' })
    expect(skipped).toEqual(expectedGaps)
    expect(delivered).toEqual([...(mask & 1 ? [] : [protectedEvent]), ...(mask & 2 ? [] : [retainedEvent])])
    expect((await f.proxy.reconcile(session, f.start.correlationId)).terminalTurn).toEqual(history.terminalTurn)
    expect(f.request.mock.calls.filter(([method]) => method === 'start-turn')).toHaveLength(1)
  })

  it.each([false, true])('rejects an unreported hole before an oversized event (explicit gap: %s)', async explicit => {
    const history: NativeHistory = {
      ...terminal([event(10), event(50, 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1))]),
      ...(explicit ? { gap: { fromSequence: 11, toSequence: 48, reason: 'retention' as const } } : {}),
    }
    const f = setup(() => history)
    const session = await f.proxy.createSession(f.start)
    const consume = async () => {
      for await (const frame of f.proxy.startTurn(session, {
        prompt: 'prompt', clientCorrelationId: f.start.correlationId,
      })) expect(frame.sequence).toBe(10)
    }
    await expect(consume()).rejects.toMatchObject({ result: { error: { code: 'NATIVE_HISTORY_GAP' } } })
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
