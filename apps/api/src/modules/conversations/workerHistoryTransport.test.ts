import { expect, it } from 'vitest'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('reads oversized native events and terminal records within the unchanged channel limit', async () => {
  const f = workerConversationFixture()
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const event = { sequence: 0, type: 'tool.completed', occurredAt: '2026-10-05T00:00:00.000Z',
    payload: { output: 'x'.repeat(2 * DEVICE_APPLICATION_JSON_BYTES) } }
  const history: NativeHistory = { events: [event], pendingInteractions: [], nextSequence: 1,
    terminalResult: { outcome: 'succeeded', output: { text: 'y'.repeat(2 * DEVICE_APPLICATION_JSON_BYTES) } } }
  const native = { harness: 'codex', createSession: async () => f.session,
    history: async () => history, close: async () => {} } as unknown as NativeHarnessSessionManager
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => ({ manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
      start: async () => ({ kind: 'operator', configuration: f.configuration,
        workingDirectory: f.binding.workingDirectory }) as NativeSessionStart }) })
  const bridge = new MainWorkerConversationBridge()
  let responses = 0
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    bridge, current: async () => {}, channel: { binding: f.connection, request: async payload => {
      const reply = await host.handle(payload, f.connection)
      responses++
      if (Buffer.byteLength(JSON.stringify(reply)) > DEVICE_APPLICATION_JSON_BYTES) throw new Error('payload-too-large')
      return { payload: reply }
    } } })
  try {
    await manager.createSession({ kind: 'operator', configuration: f.configuration,
      workingDirectory: f.binding.workingDirectory, correlationId: 'creation' } as NativeSessionStart)
    await expect(manager.history(f.session)).resolves.toMatchObject(history)
    expect(responses).toBeGreaterThan(2)
  } finally { await manager.dispose(); await bridge.close(); await host.shutdown() }
})

it('drains completed output through the snapshot sequence boundary', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const receipt: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
    revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
    turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
  const events = Array.from({ length: 3 }, (_, sequence) => ({ sequence, type: 'tool.completed',
    occurredAt: '2026-10-05T00:00:00.000Z', payload: { output: 'x'.repeat(200_000) } }))
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    bridge, current: async () => {}, channel: { binding: f.connection, request: async raw => {
      const request = raw as { method: string; correlationId?: string; afterSequence?: number }
      if (request.method === 'conversation.start-turn') {
        receipt.turns = [{ correlationId: 'turn', inputHash: commandInputHash('turn'), nativeTurnId: 'native-turn',
          status: 'completed', result: { outcome: 'succeeded' } }]
        receipt.revision++
      }
      if (request.method === 'conversation.history') return { payload: { receipt, context: null,
        history: { pendingInteractions: [], nextSequence: request.correlationId ? 3 : 0,
          events: request.correlationId ? events.filter(event => event.sequence > (request.afterSequence ?? -1)).slice(0, 1) : [] } } }
      return { payload: { receipt } }
    } } })
  try {
    await manager.attachSession(f.session, { kind: 'operator', configuration: f.configuration,
      workingDirectory: f.binding.workingDirectory, correlationId: 'turn' } as NativeSessionStart)
    const observed = []
    for await (const event of manager.startTurn(f.session, { prompt: 'Continue', clientCorrelationId: 'turn' })) observed.push(event)
    expect(observed).toEqual(events)
  } finally { await manager.dispose(); await bridge.close() }
})
