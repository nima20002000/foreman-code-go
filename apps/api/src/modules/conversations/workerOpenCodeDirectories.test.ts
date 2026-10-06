import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { WorkerOpenCodeDirectories } from './workerOpenCodeDirectories.js'

async function fixture() {
  const state = await privateFixtureDirectory('worker-file-directories-')
  let journal: RemoteOperationJournal | undefined
  onTestFinished(async () => {
    try { await journal?.close() } finally { await rm(state, { recursive: true, force: true }) }
  })
  const file = join(state, 'operations.json')
  journal = await RemoteOperationJournal.open(file, { initializeNewInstallation: true })
  const f = workerConversationFixture('agent', 'opencode')
  let launch: NativeLaunchObservation = { owner: `conversation:${f.binding.owner.conversationId}`,
    launchId: randomUUID(), bootId: f.connection.bootId, lifecycle: 'active',
    guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' },
    boundary: { kind: 'cgroup-v2', path: '/recorded/native-boundary', device: '1', inode: '2' } }
  const owner = { sessionId: f.session.nativeSessionId, processIdentityDigest: workerConversationProcessDigest(f.binding, launch) }
  await journal.conversations.receive(f.binding, f.connection)
  await journal.conversations.reserveCreation(f.binding, 'create', commandInputHash('create'))
  await journal.conversations.bindSession(f.binding, f.session, owner)
  await journal.conversations.reserveTurn(f.binding, 'accepted-input', commandInputHash('input'))
  let directories = new WorkerOpenCodeDirectories(state, journal.conversations)
  return { ...f, state, launch, owner,
    create: (correlationId = 'accepted-input', nativeSessionId: string = f.session.nativeSessionId) =>
      directories.create(f.binding, correlationId, nativeSessionId),
    record: () => journal!.conversations.read(f.binding),
    async reopen() {
      await journal!.close()
      journal = await RemoteOperationJournal.open(file)
      directories = new WorkerOpenCodeDirectories(state, journal.conversations)
    },
    async cleanup() {
      const record = (await journal!.conversations.read(f.binding))!
      await directories.cleanupClosed(record, { snapshot: () => ({ revision: 'recorded', launches: [launch] }) },
        AbortSignal.timeout(5000))
    },
    closed() { launch = { ...launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' } },
  }
}

// Process closure is recorded; journal persistence and descriptor-anchored filesystem cleanup are real.
it('recovers owned scratch after a worker restart only after its original native owner is positively closed', async () => {
  const f = await fixture()
  const root = await f.create()
  const child = join(root.path, randomUUID())
  await mkdir(child, { mode: 0o700 })
  await writeFile(join(child, 'working-copy.md'), '# unpublished native edits\n')
  const foreign = join(f.state, 'foreign.md')
  await writeFile(foreign, '# unrelated bytes\n')
  await symlink(foreign, join(child, 'foreign-link'))
  const before = await f.record()
  await f.reopen()
  await expect(f.cleanup()).rejects.toMatchObject({ code: 'WORKER_FILE_CLEANUP_REQUIRED' })
  expect(await readFile(join(child, 'working-copy.md'), 'utf8')).toBe('# unpublished native edits\n')
  f.closed()
  await f.cleanup()
  expect(await readdir(join(f.state, 'opencode-chat-files'))).toEqual([])
  expect(await readFile(foreign, 'utf8')).toBe('# unrelated bytes\n')
  const after = await f.record()
  expect(after?.openCodeFileRoots).toEqual([])
  expect(after?.session).toEqual(before?.session)
  expect(after?.nativeOwner).toEqual(before?.nativeOwner)
  expect(after?.turns).toEqual(before?.turns)
  await f.cleanup()
})

it('refuses a replacement directory and retains the original cleanup record', async () => {
  const f = await fixture()
  const root = await f.create()
  await rename(root.path, `${root.path}-original`)
  await mkdir(root.path, { mode: 0o700 })
  await writeFile(join(root.path, 'foreign.md'), '# replacement\n')
  f.closed()
  await expect(f.cleanup()).rejects.toMatchObject({ code: 'WORKER_FILE_CLEANUP_REQUIRED' })
  expect(await readFile(join(root.path, 'foreign.md'), 'utf8')).toBe('# replacement\n')
  expect((await f.record())?.openCodeFileRoots).toEqual([root.record])
})

it('fences directory materialization from another native session or an unadmitted turn', async () => {
  const f = await fixture()
  const journal = await f.record()
  expect(journal?.openCodeFileRoots).toBeUndefined()
  await expect(f.create('accepted-input', 'foreign-session')).rejects.toMatchObject({ status: 409 })
  await expect(f.create('unadmitted-turn')).rejects.toMatchObject({ status: 409 })
  const root = await f.create()
  expect((await f.create()).record).toEqual(root.record)
  f.closed()
  await f.cleanup()
})
