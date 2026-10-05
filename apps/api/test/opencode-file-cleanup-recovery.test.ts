import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { ownOpenCodeDirectory } from '../src/modules/harnesses/opencodeFiles/cleanup.js'
import { OpenCodeFileCleanupJournal } from '../src/modules/harnesses/opencodeFiles/cleanupJournal.js'
import { fileContext } from './support/opencodeChatFileFixture.js'

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
