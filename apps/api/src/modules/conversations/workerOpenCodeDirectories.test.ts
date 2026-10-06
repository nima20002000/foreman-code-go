import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { WorkerOpenCodeDirectories } from './workerOpenCodeDirectories.js'
import { workerOpenCodeVersionRecovery } from './recoverWorkerOpenCodeFiles.js'
import { MainWorkerOpenCodeFiles } from './mainWorkerOpenCodeFiles.js'
import { fileToolFixture } from '../../../test/support/fileTools.js'
import { AgentFileCreateWorkingCopyResultSchema } from '@foreman-code/contracts/files'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { nativeMessageId } from '../harnesses/opencodeProtocol.js'

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
    submitted: () => journal!.conversations.submitted(f.binding, 'accepted-input', {
      nativeTurnId: nativeMessageId('accepted-input'),
    }),
    async cleanup(recoverVersions?: Parameters<WorkerOpenCodeDirectories['cleanupClosed']>[3]) {
      const record = (await journal!.conversations.read(f.binding))!
      await directories.cleanupClosed(record, { snapshot: () => ({ revision: 'recorded', launches: [launch] }) },
        AbortSignal.timeout(5000), recoverVersions)
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

it('retains displaced native versions and the whole cleanup record after confirmed process closure', async () => {
  const f = await fixture()
  const root = await f.create()
  const child = join(root.path, randomUUID())
  const versions = join(child, `.versions-${randomUUID()}`)
  await mkdir(versions, { recursive: true, mode: 0o700 })
  await writeFile(join(child, 'working-copy.md'), '# current\n')
  await writeFile(join(versions, 'native'), '# displaced native\n')
  await writeFile(join(versions, 'edited'), '# file-tool edit\n')
  f.closed()
  await f.reopen()
  await expect(f.cleanup()).rejects.toMatchObject({ code: 'WORKER_FILE_VERSION_RECOVERY_REQUIRED' })
  expect(await readFile(join(child, 'working-copy.md'), 'utf8')).toBe('# current\n')
  expect(await readFile(join(versions, 'native'), 'utf8')).toBe('# displaced native\n')
  expect(await readFile(join(versions, 'edited'), 'utf8')).toBe('# file-tool edit\n')
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

it('persists cold native, file-tool and current versions before removing scratch, with current Main grants', async () => {
  const f = await fixture()
  const files = await fileToolFixture()
  const ref = await files.upload()
  const context = { ...files.context, nativeSessionId: f.session.nativeSessionId,
    turnId: nativeMessageId('accepted-input'), messageId: 'accepted-message' }
  const token = await files.issue(context)
  const copied = AgentFileCreateWorkingCopyResultSchema.parse(await files.service.createWorkingCopy(token, {
    commandId: randomUUID(), source: ref, destination: files.scope,
  }))
  await files.sessions.revoke(token)
  const root = await f.create()
  const child = join(root.path, copied.value.artifactId)
  const versions = join(child, `.versions-${randomUUID()}`)
  await mkdir(versions, { recursive: true, mode: 0o700 })
  await writeFile(join(child, 'source.md'), '# current\n')
  await writeFile(join(versions, 'native'), '# displaced native\n')
  await writeFile(join(versions, 'edited'), '# file-tool edit\n')
  await f.submitted()
  f.closed()
  await f.reopen()
  const before = await f.record()
  if (!before) throw new Error('The original Worker journal is unavailable.')
  const request: WorkerConversationRpcRequest = { method: 'conversation.reconcile', admissionId: randomUUID(),
    binding: f.binding, session: f.session, correlationId: 'accepted-input' }
  const adopt = vi.fn(async () => {})
  const main = new MainWorkerOpenCodeFiles({ service: () => files.service,
    sourceHost: () => ({ bootId: f.connection.bootId, storageRoot: '/recorded-main-vault' }),
    resolve: async () => ({ context, attachments: [ref] }), adopt })
  onTestFinished(() => main.close())
  const issue = vi.spyOn(files.sessions, 'issueForAcceptedSession')
  onTestFinished(() => issue.mockRestore())
  let allowed = false
  const callbacks = { openCodeFiles: async (_request: WorkerConversationRpcRequest,
    identity: Parameters<MainWorkerOpenCodeFiles['handle']>[0],
    action: Parameters<MainWorkerOpenCodeFiles['handle']>[1], signal: AbortSignal) => {
    expect(_request).toEqual(request)
    if (!allowed) throw new Error('Original sender revoked')
    return main.handle(identity, action, { acknowledgedTurnId: context.turnId, readOnly: false,
      recovering: true, signal })
  } }
  const recover = workerOpenCodeVersionRecovery({ record: before, request, configuration: f.configuration, callbacks })
  await expect(f.cleanup(recover)).rejects.toThrow('Original sender revoked')
  expect(await readFile(join(versions, 'native'), 'utf8')).toBe('# displaced native\n')
  expect((await f.record())?.openCodeFileRoots).toEqual(before.openCodeFileRoots)
  allowed = true
  const adoptFailure = new Error('Publication adoption interrupted')
  adopt.mockRejectedValueOnce(adoptFailure)
  await expect(f.cleanup(recover)).rejects.toThrow('Publication adoption interrupted')
  expect(await readFile(join(versions, 'edited'), 'utf8')).toBe('# file-tool edit\n')
  await f.cleanup(recover)
  expect(issue).not.toHaveBeenCalled()
  expect(await readdir(join(f.state, 'opencode-chat-files'))).toEqual([])
  const after = await f.record()
  expect(after?.openCodeFileRoots).toEqual([])
  expect(after?.session).toEqual(before.session)
  expect(after?.nativeOwner).toEqual(before.nativeOwner)
  expect(after?.turns).toEqual(before.turns)
  const reader = await files.issue(context)
  const saved = await files.service.list(reader, { scope: files.scope, limit: 100 })
  const recovered = saved.items.filter(value => value.revision.filename.includes('-recovered-'))
  expect(recovered).toHaveLength(3)
  const bytes = await Promise.all(recovered.map(async value => {
    const read = await files.service.read(reader, { fileId: value.file.fileId,
      revisionId: value.revision.revisionId, offset: 0, length: 65536 })
    if (read.status !== 'ready') throw new Error('The recovered version is unavailable.')
    return Buffer.from(read.contentBase64, 'base64').toString('utf8')
  }))
  expect(bytes.sort()).toEqual(['# current\n', '# displaced native\n', '# file-tool edit\n'].sort())
})
