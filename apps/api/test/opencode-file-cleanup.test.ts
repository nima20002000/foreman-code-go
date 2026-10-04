import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'vitest'
import type { FileRevision } from '@graphql/contracts/files'
import { sha256 } from '../src/modules/harnesses/opencodeFiles/attachments.js'
import { LocalOpenCodeExecutionFiles } from '../src/modules/harnesses/opencodeFiles/host.js'
import { OpenCodeFileTurn } from '../src/modules/harnesses/opencodeFiles/turn.js'
import { OpenCodeFileCleanupError } from '../src/modules/harnesses/opencodeFiles/types.js'
import { object } from '../src/modules/harnesses/opencodeProtocol.js'
import { FixtureServer, json } from './opencode-fixtures.js'
import { createChatFileBackend, fileContext, fileSignal, hasFileCode } from './support/opencodeChatFileFixture.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opencode-cleanup-'))
  await mkdir(join(root, 'execution'))
  const host = new LocalOpenCodeExecutionFiles({
    executionHostId: 'execution-b', root: join(root, 'execution'), maxFileBytes: 1024,
    // FixtureServer has no native process or filesystem access.
    assertSourceIsolation: async () => undefined,
  })
  const bytes = Buffer.from('registered input')
  const revision: FileRevision = {
    fileId: randomUUID(), revisionId: randomUUID(), filename: 'input.md', mediaType: 'text/markdown',
    byteSize: bytes.length, sha256: sha256(bytes), origin: 'upload', createdAt: new Date().toISOString(),
  }
  const handles: string[] = []
  return { root, host,
    async materialize() {
      const handle = randomUUID()
      handles.push(handle)
      return host.materialize({ handle, revision, bytes, writable: true }, fileSignal())
    },
    async close() {
      try { for (const handle of handles) await host.remove(handle) }
      finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

describe('OpenCode owned file cleanup', () => {
  it('removes sidecars and nested directories without following soft or hard links', async () => {
    const f = await fixture()
    try {
      const file = await f.materialize()
      const directory = dirname(file.path)
      const outside = join(f.root, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'private.md'), 'keep outside bytes')
      await writeFile(`${file.path}.bak`, 'editor backup')
      await mkdir(join(directory, 'extracted', 'nested'), { recursive: true })
      await writeFile(join(directory, 'extracted', 'nested', 'temp.md'), 'temporary bytes')
      await symlink(outside, join(directory, 'directory-link'))
      await symlink(join(outside, 'private.md'), join(directory, 'file-link'))
      await link(join(outside, 'private.md'), join(directory, 'hard-link'))
      await f.host.remove(file.handle)
      await f.host.remove(file.handle)
      assert.deepEqual(await readdir(join(f.root, 'execution')), [])
      assert.equal(await readFile(join(outside, 'private.md'), 'utf8'), 'keep outside bytes')
      assert.deepEqual(await readdir(outside), ['private.md'])
    } finally {
      await f.close()
    }
  })

  it('refuses replacement directories and symlinks and remains retryable with the owned directory', async () => {
    const f = await fixture()
    try {
      const file = await f.materialize()
      const directory = dirname(file.path)
      const held = join(f.root, 'held')
      await rename(directory, held)
      await mkdir(directory)
      await writeFile(join(directory, 'foreign.md'), 'keep replacement')
      await assert.rejects(f.host.remove(file.handle), hasFileCode('FILE_CLEANUP_REQUIRED'))
      assert.equal(await readFile(join(directory, 'foreign.md'), 'utf8'), 'keep replacement')
      assert.equal(await readFile(join(held, 'input.md'), 'utf8'), 'registered input')
      await rm(directory, { recursive: true })
      await symlink(held, directory)
      await assert.rejects(f.host.remove(file.handle), hasFileCode('FILE_CLEANUP_REQUIRED'))
      assert.equal(await readFile(join(held, 'input.md'), 'utf8'), 'registered input')
      await rm(directory)
      await rename(held, directory)
      await f.host.remove(file.handle)
    } finally {
      await f.close()
    }
  })

  it('releases revoked terminal ownership after disk failure, cleans other handles, and retains failed cleanup', async () => {
    const f = await fixture()
    const backend = createChatFileBackend()
    const server = new FixtureServer()
    server.config = { mcp: { graphql: { enabled: false } } }
    server.mcp = { graphql: { status: 'disabled' } }
    server.beforeRequest = (path, init) => {
      if (new URL(path, 'http://fixture.invalid').pathname !== '/mcp' || init.method !== 'POST') return
      const body = object(JSON.parse(String(init.body)))
      server.mcp[String(body.name)] = { status: 'connected' }
      return json(server.mcp)
    }
    const options = {
      service: backend.service, host: f.host, server, endpoint: 'http://127.0.0.1:9876/mcp/files',
      appMcpServerName: 'graphql', maxFileBytes: 1024, maxAttachments: 10,
      adoptPublished: backend.adoptPublished,
    }
    const turn = new OpenCodeFileTurn(options)
    let moved: { original: string; held: string } | undefined
    const admission = {
      context: fileContext(), attachments: [backend.add(), backend.add('second')],
      mode: 'write' as const, executionHostId: 'execution-b', directory: '/workspace/project',
      expiresAt: new Date(Date.now() + 60_000),
    }
    try {
      await turn.prepareInputs(admission, backend.readAccepted(admission.context), fileSignal())
      await turn.connectTools(fileSignal())
      turn.submissionAttempted()
      await turn.acknowledge(fileSignal())
      const token = backend.token
      const directories = await readdir(join(f.root, 'execution'))
      const directory = join(f.root, 'execution', directories[0]!)
      const held = join(f.root, 'held')
      moved = { original: directory, held }
      await rename(directory, held)
      await mkdir(directory)
      await writeFile(join(directory, 'foreign.md'), 'keep replacement')
      await assert.rejects(turn.finish('terminal', fileSignal()), OpenCodeFileCleanupError)
      assert.equal(backend.revocations, 1)
      assert.throws(() => turn.assertCredential(token), hasFileCode('FILE_TURN_CLOSED'))
      assert.deepEqual(await readdir(join(f.root, 'execution')), [directories[0]])
      assert.equal(await readFile(join(directory, 'foreign.md'), 'utf8'), 'keep replacement')
      assert.equal(Object.values(server.mcp).some((entry) => object(entry).status === 'connected'), false)

      const next = new OpenCodeFileTurn(options)
      const nextAdmission = { ...admission, attachments: [], context: fileContext({ turnId: 'turn-b' }) }
      await next.prepareInputs(nextAdmission, backend.readAccepted(nextAdmission.context), fileSignal())
      await next.finish('definite_rejection', fileSignal())
      await rm(directory, { recursive: true })
      await rename(held, directory)
      moved = undefined
      await turn.retryCleanup(fileSignal())
      await turn.retryCleanup(fileSignal())
      assert.deepEqual(await readdir(join(f.root, 'execution')), [])
      assert.equal(backend.issued.length, 1)
    } finally {
      if (moved) {
        await rm(moved.original, { recursive: true, force: true })
        await rename(moved.held, moved.original)
      }
      try { await turn.nativeProcessClosed(fileSignal()) }
      finally { await f.close() }
    }
  })
})
