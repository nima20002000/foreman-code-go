import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import { SessionPreferencesSchema } from '@graphql/contracts'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })
async function journal(capacity = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'worker-chat-journal-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'operations.json')
  const store = await RemoteOperationJournal.open(path, { initializeNewInstallation: true, capacity })
  closing.push(() => store.close())
  return { path, store, chats: store.conversations }
}
async function opened() {
  const f = workerConversationFixture()
  const j = await journal()
  await j.chats.receive(f.binding, f.connection)
  await j.chats.reserveCreation(f.binding, 'initial-message', commandInputHash({ mode: 'create' }))
  await j.chats.bindSession(f.binding, f.session, f.nativeOwner)
  return { ...j, ...f }
}

it('reserves one native creation concurrently and retains its real session across reopen', async () => {
  const f = workerConversationFixture()
  const j = await journal()
  await j.chats.receive(f.binding, f.connection)
  const create = () => j.chats.reserveCreation(f.binding, 'original-request', commandInputHash({ mode: 'create' }))
  const reservations = await Promise.all([create(), create()])
  expect(reservations.filter(value => value.dispatch)).toHaveLength(1)
  await j.chats.bindSession(f.binding, f.session, f.nativeOwner)
  await j.store.close()
  const reopened = await RemoteOperationJournal.open(j.path)
  closing.push(() => reopened.close())
  expect((await reopened.conversations.read(f.binding))?.session).toEqual(f.session)
  expect((await reopened.conversations.reserveCreation(f.binding, 'original-request', commandInputHash({ mode: 'create' }))).dispatch)
    .toBe(false)
  await expect(reopened.conversations.reserveCreation(f.binding, 'replacement', commandInputHash({ mode: 'create' })))
    .rejects.toThrow('another request')
})

it('keeps successive turns on one chat session and fences an unresolved turn', async () => {
  const f = await opened()
  const reserve = (id: string) => f.chats.reserveTurn(f.binding, id, commandInputHash({ prompt: id }))
  expect((await reserve('first')).dispatch).toBe(true)
  await expect(reserve('second')).rejects.toThrow('pending')
  await f.chats.submitted(f.binding, 'first', { nativeTurnId: 'native-first' })
  await f.chats.finishTurn(f.binding, 'first', { outcome: 'succeeded' })
  expect((await reserve('second')).dispatch).toBe(true)
  expect((await reserve('second')).dispatch).toBe(false)
  expect((await f.chats.read(f.binding))?.session).toEqual(f.session)
  await expect(f.chats.reserveTurn(f.binding, 'second', commandInputHash({ prompt: 'changed' })))
    .rejects.toThrow('input changed')
})

it('does not reoffer uncertain input or lose a completed result on an empty history read', async () => {
  const f = await opened()
  await f.chats.reserveTurn(f.binding, 'uncertain', commandInputHash({ prompt: 'task' }))
  await f.chats.finishTurn(f.binding, 'uncertain')
  expect((await f.chats.reserveTurn(f.binding, 'uncertain', commandInputHash({ prompt: 'task' }))).dispatch).toBe(false)
  await expect(f.chats.reserveTurn(f.binding, 'next', commandInputHash({ prompt: 'next' }))).rejects.toThrow('pending')
  await f.chats.finishTurn(f.binding, 'uncertain', { outcome: 'succeeded' })
  await f.chats.finishTurn(f.binding, 'uncertain')
  expect((await f.chats.read(f.binding))?.turns[0]).toMatchObject({ status: 'completed', result: { outcome: 'succeeded' } })
})

it('persists compaction reservation/outcome and never dispatches the same request twice', async () => {
  const f = await opened()
  const hash = commandInputHash({ correlationId: 'compact' })
  const reserved = await f.chats.reserveCompact(f.binding, 'compact-request', hash)
  expect(reserved.dispatch).toBe(true)
  await f.chats.compactProgress(f.binding, { ...reserved.state, status: 'uncertain', dispatchPhase: 'offered' })
  expect((await f.chats.reserveCompact(f.binding, 'compact-request', hash)).dispatch).toBe(false)
  await expect(f.chats.reserveTurn(f.binding, 'task', commandInputHash({ prompt: 'task' }))).rejects.toThrow('pending')
  const completed = { ...reserved.state, status: 'completed' as const, nativeOperationId: 'observed-boundary' }
  await f.chats.compactProgress(f.binding, completed)
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect((await reopened.conversations.reserveCompact(f.binding, 'compact-request', hash))).toMatchObject({
    dispatch: false, state: { status: 'completed', nativeOperationId: 'observed-boundary' } })
  await expect(reopened.conversations.compactProgress(f.binding, { ...completed, nativeSessionId: 'another-session' }))
    .rejects.toThrow('does not belong')
})

it('isolates two nodes with the same Agent and rejects another role/profile binding', async () => {
  const f = workerConversationFixture('agent')
  const j = await journal()
  const second = { ...f.binding, owner: { ...f.binding.owner, conversationId: randomUUID(), workflowNodeId: 'second-node' } }
  await j.chats.receive(f.binding, f.connection)
  await j.chats.receive(second, f.connection)
  const preferences = SessionPreferencesSchema.parse({ autoCompact: 'off' })
  await j.chats.preferences(f.binding, preferences, null)
  expect((await j.chats.read(second))?.desiredPreferences).toBeNull()
  await expect(j.chats.read({ ...f.binding, profile: { ...f.binding.profile, instanceRevision: 'replacement' } }))
    .rejects.toThrow('binding changed')
  await expect(j.chats.receive({ ...f.binding, owner: { kind: 'operator', operatorId: 'application-operator',
    conversationId: f.binding.owner.conversationId, configurationVersionId: f.configuration.id,
    configurationHash: f.binding.owner.configurationHash } }, f.connection)).rejects.toThrow('another owner')
})

it('fences a closing chat before physical closure and preserves it when capacity is exhausted', async () => {
  const f = workerConversationFixture()
  const j = await journal(1)
  await j.chats.receive(f.binding, f.connection)
  await j.chats.closeRequested(f.binding)
  await expect(j.chats.reserveCreation(f.binding, 'late', commandInputHash({ mode: 'create' }))).rejects.toThrow('closing')
  expect((await j.chats.read(f.binding))?.closed).toBe(false)
  await j.chats.closeConfirmed(f.binding)
  await expect(j.chats.receive({ ...f.binding, owner: { ...f.binding.owner, conversationId: randomUUID() } }, f.connection))
    .rejects.toThrow('full')
  expect((await j.chats.read(f.binding))?.closed).toBe(true)
})
