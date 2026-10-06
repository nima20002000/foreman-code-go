import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
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

it('requires a reserved Operator access change before preparing its next file directory', async () => {
  const f = workerConversationFixture('operator', 'opencode')
  const j = await journal()
  const previous = { ...f.binding, appMcpAccess: 'scoped' as const }
  await j.chats.receive(previous, f.connection)
  await j.chats.reserveCreation(previous, 'create', commandInputHash('create'))
  await j.chats.bindSession(previous, f.session, f.nativeOwner)
  await expect(j.chats.reserveFileDirectory(f.binding)).rejects.toThrow('reserved access change')
  await j.chats.reserveApplicationAccess(previous, f.binding, 'disable-management-mcp', f.session)
  const directory = await j.chats.reserveFileDirectory(f.binding)
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  await j.chats.fileDirectoryCreated(f.binding, directory.id, filesystem)
  await j.store.close()
  const reopened = await RemoteOperationJournal.open(j.path)
  closing.push(() => reopened.close())
  const record = await reopened.conversations.inspectBinding(f.binding)
  expect(record?.binding).toEqual(previous)
  expect(record?.applicationAccessChange?.state).toBe('reserved')
  expect(record?.openCodeFileDirectory).toEqual({ id: directory.id, filesystem })
  expect(record?.nativeOwner).toEqual(f.nativeOwner)
  expect(record?.session).toEqual(f.session)
  const changedProfile = { ...f.binding, profile: { ...f.binding.profile, instanceRevision: 'changed-profile' } }
  await expect(reopened.conversations.reserveFileDirectory(changedProfile)).rejects.toThrow('original owner')
})

it('persists the conversation file directory and refuses an inode replacement', async () => {
  const f = workerConversationFixture('agent', 'opencode')
  const j = await journal()
  await j.chats.receive(f.binding, f.connection)
  const directory = await j.chats.reserveFileDirectory(f.binding)
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  await j.chats.fileDirectoryCreated(f.binding, directory.id, filesystem)
  await expect(j.chats.fileDirectoryCreated(f.binding, directory.id, { ...filesystem, inode: '4' }))
    .rejects.toThrow('directory changed')
  expect((await j.chats.fileRecords())[0]?.openCodeFileDirectory).toEqual({ id: directory.id, filesystem })
  expect(await j.chats.reserveFileDirectory(f.binding)).toEqual({ id: directory.id, filesystem })
})

it('persists the effective Plan mode with the accepted worker turn and rejects changed-mode replay', async () => {
  const f = await opened()
  const hash = commandInputHash({ prompt: 'Accepted Plan task', mode: 'plan' })
  await f.chats.reserveTurn(f.binding, 'plan-task', hash, { mode: 'plan' })
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect((await reopened.conversations.read(f.binding))?.turns.find(turn => turn.correlationId === 'plan-task')?.sessionMode)
    .toBe('plan')
  await expect(reopened.conversations.reserveTurn(f.binding, 'plan-task', hash, { mode: 'regular' }))
    .rejects.toThrow('original turn input changed')
})

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

it('retains one access handoff across reopen and changes only the native process and App MCP access', async () => {
  const f = await opened()
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const reserved = await f.chats.reserveApplicationAccess(f.binding, next, 'access-change', f.session)
  expect(reserved).toMatchObject({ applied: false, reserved: true })
  await expect(f.chats.reserveTurn(f.binding, 'new-message', commandInputHash('new-message')))
    .rejects.toThrow('access change needs recovery')
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect(await reopened.conversations.reserveApplicationAccess(f.binding, next, 'access-change', f.session))
    .toMatchObject({ applied: false, reserved: false })
  await expect(reopened.conversations.reserveApplicationAccess(f.binding, next, 'different-change', f.session))
    .rejects.toThrow('needs recovery')
  const newOwner = { ...f.nativeOwner, processIdentityDigest: 'c'.repeat(64) }
  await reopened.conversations.recoveredOwner(f.binding, f.connection, f.nativeOwner, newOwner, next)
  const saved = await reopened.conversations.read(next)
  expect(saved?.session).toEqual(f.session)
  expect(saved?.binding).toEqual(next)
  expect(saved?.nativeOwner).toEqual(newOwner)
  expect(saved?.creation).toEqual(reserved.record.creation)
  expect(saved?.applicationAccessChange?.state).toBe('applied')
  expect(await reopened.conversations.reserveApplicationAccess(f.binding, next, 'access-change', f.session))
    .toMatchObject({ applied: true, reserved: false })
})

it('rejects pending work, foreign sessions and changed saved owners before reserving an access handoff', async () => {
  const f = await opened()
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const before = await f.chats.read(f.binding)
  await expect(f.chats.reserveApplicationAccess(f.binding, next, 'foreign-session', {
    ...f.session, nativeSessionId: 'another-session',
  })).rejects.toThrow('settled Operator')
  await expect(f.chats.reserveApplicationAccess(f.binding, { ...next, workingDirectory: '/other-project' },
    'changed-directory', f.session)).rejects.toThrow('settled Operator')
  expect(await f.chats.read(f.binding)).toEqual(before)
  await f.chats.reserveTurn(f.binding, 'active-message', commandInputHash('active-message'))
  await expect(f.chats.reserveApplicationAccess(f.binding, next, 'active-change', f.session))
    .rejects.toThrow('settled Operator')
  expect((await f.chats.read(f.binding))?.applicationAccessChange).toBeUndefined()
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
  await f.chats.compactProgress(f.binding, { ...reserved.state, status: 'uncertain', dispatchPhase: 'dispatched' })
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

it('retains native session and input records when a settled owner is recovered on the same paired installation', async () => {
  const f = await opened()
  const next = { ...f.nativeOwner, processIdentityDigest: 'd'.repeat(64) }
  const connection = { ...f.connection, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2 }
  const before = await f.chats.read(f.binding)
  await f.chats.recoveredOwner(f.binding, connection, f.nativeOwner, next)
  const after = await f.chats.read(f.binding)
  expect(after?.nativeOwner).toEqual(next)
  expect(after?.session).toEqual(before?.session)
  expect(after?.turns).toEqual(before?.turns)
  expect(after?.creation).toEqual(before?.creation)
  expect(after?.connection).toEqual(connection)
})

it('refuses owner recovery across a pending input, foreign session or changed device authority', async () => {
  const f = await opened()
  const next = { ...f.nativeOwner, processIdentityDigest: 'd'.repeat(64) }
  await expect(f.chats.recoveredOwner(f.binding, { ...f.connection, authorizationRevision: 2 }, f.nativeOwner, next))
    .rejects.toThrow('authority changed')
  await expect(f.chats.recoveredOwner(f.binding, f.connection, f.nativeOwner, { ...next, sessionId: 'foreign-session' }))
    .rejects.toThrow('settled conversation')
  await f.chats.reserveTurn(f.binding, 'pending-message', commandInputHash('pending-input'))
  await expect(f.chats.recoveredOwner(f.binding, f.connection, f.nativeOwner, next)).rejects.toThrow('settled conversation')
  expect((await f.chats.read(f.binding))?.nativeOwner).toEqual(f.nativeOwner)
})
