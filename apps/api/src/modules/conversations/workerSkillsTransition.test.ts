import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

async function fixture() {
  const f = workerConversationFixture('agent')
  const base = AgentConfigurationVersionSchema.parse(f.configuration)
  const instructions = 'Use the node skill.'
  const configuration = { ...base, assignedSkills: [{ skillId: 'node-skill', version: '1' }],
    resolvedSkills: [{ skillId: 'node-skill', version: '1', instructions,
      contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}` }] }
  const binding = { ...f.binding, owner: { ...f.binding.owner, configurationHash: commandInputHash(configuration) } }
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  await journal.receive(f.binding, f.connection)
  await journal.reserveCreation(f.binding, 'original-create', commandInputHash('original-create'))
  await journal.bindSession(f.binding, f.session, f.nativeOwner)
  const close = vi.fn(async () => {})
  const start = { kind: 'agent-chat', configuration: base, conversationId: f.binding.owner.conversationId,
    workflowId: 'workflow', workflowNodeId: 'node', workingDirectory: f.binding.workingDirectory } as NativeSessionStart
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const native = { harness: 'codex',
    async *startTurn(_session: unknown, input: NativeTurnInput) {
      await input.onSubmitted?.('active-turn')
      entered()
      await held
      yield { type: 'turn.completed', sequence: 1, occurredAt: '2026-10-01T00:00:00Z', payload: {} }
    },
    reconcile: async () => ({ events: [], pendingInteractions: [], correlationId: 'active-input',
      nativeTurnId: 'active-turn', terminalResult: { outcome: 'succeeded' } }),
  } as unknown as NativeHarnessSessionManager
  const allocation = { manager: native, close, start: async () => start, nativeOwner: async () => f.nativeOwner }
  const recover = vi.fn(async () => allocation)
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => allocation, recover })
  await host.handle({ method: 'conversation.open', binding: f.binding, configuration: base,
    operationId: 'attach', mode: 'attach', source: f.session }, f.connection)
  recover.mockClear()
  const transition = () => host.handle({ method: 'conversation.open', binding, configuration,
    previousBinding: f.binding, previousConfiguration: base, operationId: 'skills',
    mode: 'attach', source: f.session }, f.connection)
  return { ...f, journal, host, close, recover, transition, started, finish,
    cleanup: async () => { finish(); await host.shutdown() } }
}

it('keeps the native owner open while a Run chat turn is still pumping after its journal result', async () => {
  const f = await fixture()
  try {
    await f.host.handle({ method: 'conversation.start-turn', binding: f.binding, session: f.session,
      prompt: 'Continue', correlationId: 'active-input' }, f.connection)
    await f.started
    // The native stream can still be draining after another observer saves its terminal result.
    await f.journal.finishTurn(f.binding, 'active-input', { outcome: 'succeeded' })
    await expect(f.transition()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
    expect(f.close).not.toHaveBeenCalled()
    expect(f.recover).not.toHaveBeenCalled()
    expect((await f.journal.read(f.binding))?.session).toEqual(f.session)
  } finally { await f.cleanup() }
})

it.each(['reserved', 'submitted', 'uncertain', 'compacting'] as const)(
  'keeps the original Run chat owner while the journal has %s work after restart', async state => {
    const f = await fixture()
    try {
      if (state === 'compacting') {
        await f.journal.reserveCompact(f.binding, 'compact', commandInputHash('compact'))
      } else {
        await f.journal.reserveTurn(f.binding, 'unfinished', commandInputHash('unfinished'))
        if (state === 'submitted') await f.journal.submitted(f.binding, 'unfinished', { nativeTurnId: 'original-turn' })
        if (state === 'uncertain') await f.journal.finishTurn(f.binding, 'unfinished')
      }
      const before = await f.journal.read(f.binding)
      await expect(f.transition()).rejects.toThrow()
      expect(f.close).not.toHaveBeenCalled()
      expect(f.recover).not.toHaveBeenCalled()
      expect(await f.journal.read(f.binding)).toEqual(before)
    } finally { await f.cleanup() }
  })
