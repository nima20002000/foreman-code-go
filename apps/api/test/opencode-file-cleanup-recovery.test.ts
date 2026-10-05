import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'
import { ownOpenCodeDirectory } from '../src/modules/harnesses/opencodeFiles/cleanup.js'
import { OpenCodeFileCleanupJournal } from '../src/modules/harnesses/opencodeFiles/cleanupJournal.js'
import { recoverOpenCodeVersions } from '../src/modules/harnesses/opencodeFiles/recoverVersions.js'
import { fileContext } from './support/opencodeChatFileFixture.js'
import { fileToolFixture } from './support/fileTools.js'

it('recovers a quarantined turn from persisted ownership after native closure using a fresh journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-cleanup-recovery-'))
  const parent = join(root, 'native-files')
  const turn = join(parent, 'turn')
  await mkdir(turn, { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const exited = once(child, 'exit')
  try {
    await once(child, 'spawn')
    const context = fileContext()
    const owned = await ownOpenCodeDirectory(turn)
    const conversationId = context.scope.chat.conversationId
    const journal = new OpenCodeFileCleanupJournal(join(root, 'vault'), conversationId)
    journal.register(owned, child.pid!, context)
    const otherTurn = join(parent, 'other-turn')
    await mkdir(otherTurn)
    await writeFile(join(otherTurn, 'attachment'), 'other conversation')
    const other = structuredClone(context)
    other.scope.chat.conversationId = 'other-conversation'
    const otherJournal = new OpenCodeFileCleanupJournal(join(root, 'vault'), other.scope.chat.conversationId)
    otherJournal.register(await ownOpenCodeDirectory(otherTurn), child.pid!, other)
    await writeFile(join(turn, 'backup'), 'retained bytes')
    await mkdir(join(parent, owned.quarantine))
    await rename(turn, join(parent, owned.quarantine, 'files'))
    const recovered: unknown[] = []
    await new OpenCodeFileCleanupJournal(join(root, 'vault'), conversationId).recover(async value => { recovered.push(value) },
      AbortSignal.timeout(10_000))
    assert.deepEqual(recovered, [])
    assert.deepEqual((await readdir(parent)).sort(), [owned.quarantine, 'other-turn'].sort())
    child.kill('SIGTERM')
    await exited
    await otherJournal.recover(async value => { recovered.push(value) }, AbortSignal.timeout(10_000))
    assert.deepEqual(recovered, [other])
    assert.deepEqual(await readdir(parent), [owned.quarantine])
    await new OpenCodeFileCleanupJournal(join(root, 'vault'), conversationId).recover(async value => { recovered.push(value) },
      AbortSignal.timeout(10_000))
    assert.deepEqual(recovered, [other, context])
    assert.deepEqual(await readdir(parent), [])
    assert.deepEqual(await readdir(join(root, 'vault', 'opencode-file-cleanup')), [])
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await rm(root, { recursive: true, force: true })
  }
})

it('recovers both edited versions after the API owning their descriptors crashes before publication', async () => {
  const f = await fileToolFixture()
  const root = await mkdtemp(join(tmpdir(), 'opencode-version-recovery-'))
  const turn = join(root, 'turn')
  const vault = join(root, 'vault')
  const signal = () => AbortSignal.timeout(10_000)
  const source = await f.upload()
  const copy = await f.service.createWorkingCopy(f.token, {
    commandId: 'create-before-crash', source, destination: f.scope,
  })
  const pinned = await f.artifacts.readSnapshot(await f.sessions.authenticate(f.token), copy.value.artifactId, signal())
  const native = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const nativeExited = once(native, 'exit')
  const hostModule = new URL('../src/modules/harnesses/opencodeFiles/host.ts', import.meta.url).href
  const cleanupModule = new URL('../src/modules/harnesses/opencodeFiles/cleanup.ts', import.meta.url).href
  const journalModule = new URL('../src/modules/harnesses/opencodeFiles/cleanupJournal.ts', import.meta.url).href
  const program = `
    import { mkdir, open } from 'node:fs/promises'
    import { LocalOpenCodeExecutionFiles } from ${JSON.stringify(hostModule)}
    import { ownOpenCodeDirectory } from ${JSON.stringify(cleanupModule)}
    import { OpenCodeFileCleanupJournal } from ${JSON.stringify(journalModule)}
    const [root, vault, nativePid, handle, revisionJson, content, context] = process.argv.slice(1)
    await mkdir(root, { mode: 0o700 })
    const revision = JSON.parse(revisionJson)
    const host = new LocalOpenCodeExecutionFiles({ root, executionHostId: 'runner', maxFileBytes: 1024,
      assertSourceIsolation: async () => { throw new Error('This API fixture has no native file reader.') } })
    const file = await host.materialize({ handle, revision, bytes: Buffer.from(content, 'base64'), writable: true },
      AbortSignal.timeout(10000))
    new OpenCodeFileCleanupJournal(vault).register(await ownOpenCodeDirectory(root), Number(nativePid), JSON.parse(context))
    const writer = await open(file.path, 'r+')
    await host.replace(handle, Buffer.from('# tool edit before crash\\n'), revision.sha256, AbortSignal.timeout(10000))
    await writer.truncate(0)
    const nativeEdit = Buffer.from('# native edit before crash\\n')
    await writer.write(nativeEdit, 0, nativeEdit.length, 0)
    await writer.sync()
    console.log('versions ready')
    setInterval(() => {}, 1000)
  `
  let api: ReturnType<typeof spawn> | undefined
  let apiExited: ReturnType<typeof once> | undefined
  try {
    await once(native, 'spawn')
    api = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program,
      turn, vault, String(native.pid), copy.value.artifactId, JSON.stringify(pinned.revision),
      pinned.bytes.toString('base64'), JSON.stringify(f.context)],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
    apiExited = once(api, 'exit')
    const output = await Promise.race([once(api.stdout!, 'data'),
      apiExited.then(() => { throw new Error('The API fixture exited before retaining the versions.') })])
    assert.match(String(output[0]), /versions ready/)
    api.kill('SIGKILL')
    await apiExited
    native.kill('SIGTERM')
    await nativeExited
    const journal = new OpenCodeFileCleanupJournal(vault, f.scope.chat.conversationId)
    const recover = () => journal.recover((context, owned) =>
      recoverOpenCodeVersions(f.service, context, owned, MAX_FILE_BYTES, signal()), signal())
    await recover()
    await recover()
    assert.deepEqual(await readdir(join(vault, 'opencode-file-cleanup')), [])
    await assert.rejects(readdir(turn), { code: 'ENOENT' })
    const contents: string[] = []
    for (const ref of await f.service.publishedForTurn(f.token)) {
      const result = await f.service.read(f.token, ref)
      assert.equal(result.status, 'ready')
      if (result.status === 'ready') contents.push(Buffer.from(result.contentBase64, 'base64').toString())
    }
    assert(contents.includes('# native edit before crash\n'))
    assert(contents.includes('# tool edit before crash\n'))
    assert.equal(contents.length, 2)
  } finally {
    if (api?.exitCode === null && api.signalCode === null) api.kill('SIGKILL')
    await apiExited
    if (native.exitCode === null && native.signalCode === null) native.kill('SIGKILL')
    await nativeExited
    await rm(root, { recursive: true, force: true })
  }
})
