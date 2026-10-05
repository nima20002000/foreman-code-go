import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { unavailableSessionControls, SessionPreferencesSchema } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('carries Plan and context through the issued-request bridge without creating a Run or another session', async () => {
  const f = workerConversationFixture()
  if (!('operatorId' in f.configuration)) throw new Error('Operator fixture required')
  const configuration = f.configuration
  const root = await mkdtemp(join(tmpdir(), 'worker-manager-'))
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
  const bridge = new MainWorkerConversationBridge()
  const histories = new Map<string, NativeHistory>()
  const modes: Array<string | undefined> = []
  const acknowledgments: string[] = []
  let creates = 0
  let allowed = true
  const native: NativeHarnessSessionManager = {
    harness: 'codex', capabilities: async () => { throw new Error('Unused native discovery') },
    inspectMcp: async () => { throw new Error('Unused native MCP inspection') },
    createSession: async () => { creates++; return f.session }, attachSession: async () => f.session,
    async *startTurn(_session, input) {
      modes.push(input.sessionMode)
      await input.onSubmitted?.(`observed-turn-${modes.length}`)
      await input.onSettingsApplied?.()
      const event = { sequence: modes.length, type: 'turn.completed', occurredAt: '2026-10-05T00:00:00.000Z', payload: {} }
      const result = { outcome: 'succeeded' as const, output: { text: input.prompt } }
      histories.set(input.clientCorrelationId, { events: [event], pendingInteractions: [],
        correlationId: input.clientCorrelationId, nextSequence: modes.length + 1,
        terminalTurn: { correlationId: input.clientCorrelationId, providerId: `observed-turn-${modes.length}`, result },
        terminalResult: result })
      yield event
    },
    pending: async () => undefined, respond: async () => {}, cancel: async () => true, close: async () => {},
    history: async () => [...histories.values()].at(-1) ?? { events: [], pendingInteractions: [], nextSequence: 1 },
    reconcile: async (_session, correlationId) => histories.get(correlationId) ?? { events: [], pendingInteractions: [] },
    sessionControlCapabilities: async () => unavailableSessionControls('non-qualifying-provider-fixture'),
    contextSnapshot: () => ({ nativeSessionId: f.session.nativeSessionId, model: 'fixture-model', generation: 'fixture',
      sequence: 1, observedAt: '2026-10-05T00:00:00.000Z', source: 'codex', accuracy: 'native',
      usedTokens: 80, capacityTokens: 1000, lifetimeTokens: 640, cost: null, stale: false }),
    appliedSessionPreferences: () => SessionPreferencesSchema.parse({}),
  }
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
    capture: () => ({ binding: f.connection, request: async payload => ({
      payload: await bridge.handle(payload, f.connection, AbortSignal.timeout(1000)),
    }) }) })
  const host = new WorkerConversationHost({ ...callbacks, journal: journal.conversations, currentBinding: () => f.connection,
    allocate: async () => ({ manager: native,
      start: async ({ correlationId }) => ({ kind: 'operator', configuration, correlationId, workingDirectory: f.binding.workingDirectory }),
      nativeOwner: async () => f.nativeOwner, close: async () => {} }) })
  const manager = new WorkerConversationManager({ binding: f.binding, configuration, bridge,
    channel: { binding: f.connection, request: async payload => ({ payload: await host.handle(payload, f.connection) }) },
    current: async () => { if (!allowed) throw new Error('Current principal denied') } })
  const start: NativeSessionStart = { kind: 'operator', correlationId: 'first-message',
    configuration, workingDirectory: f.binding.workingDirectory }
  try {
    const session = await manager.createSession(start)
    expect(session).toEqual(f.session)
    const events = []
    for await (const event of manager.startTurn(session, { prompt: 'Planned task', clientCorrelationId: 'planned', sessionMode: 'plan',
      onSubmitted: async id => { acknowledgments.push(id) } })) events.push(event)
    expect(modes).toEqual(['plan'])
    expect(acknowledgments).toEqual(['observed-turn-1'])
    expect(events.map(event => event.sequence)).toEqual([1])
    for await (const event of manager.startTurn(session, { prompt: 'Regular task', clientCorrelationId: 'regular', sessionMode: 'regular' })) {
      expect(event.sequence).toBe(2)
    }
    expect(creates).toBe(1)
    expect(modes).toEqual(['plan', 'regular'])
    await manager.sessionControlCapabilities(session)
    expect(manager.contextSnapshot(session)).toMatchObject({ usedTokens: 80, lifetimeTokens: 640 })
    allowed = false
    await expect(manager.cancel(session)).rejects.toThrow('Current principal denied')
    allowed = true
    await manager.closeForRestart(session)
    expect((await journal.conversations.read(f.binding))?.closed).toBe(false)
  } finally {
    await manager.dispose()
    bridge.close()
    await host.shutdown()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  }
})
