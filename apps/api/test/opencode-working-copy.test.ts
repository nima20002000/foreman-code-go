import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@graphql/contracts/files'
import { LocalOpenCodeExecutionFiles } from '../src/modules/harnesses/opencodeFiles/host.js'
import { OpenCodeFileTurn } from '../src/modules/harnesses/opencodeFiles/turn.js'
import { fileToolFixture } from './support/fileTools.js'

async function workingCopy() {
  const f = await fileToolFixture()
  const root = await mkdtemp(join(tmpdir(), 'opencode-working-copy-'))
  const host = new LocalOpenCodeExecutionFiles({ executionHostId: 'fixture-host', root,
    maxFileBytes: MAX_FILE_BYTES, async assertSourceIsolation() {
      // The real domain services keep all source bytes in memory in this fixture.
      expect(f.bytes.objects.size).toBeGreaterThan(0)
    } })
  let connected = ''
  const server = { expectedVersion: '1.18.31', generation: 1, async ensure() {}, async dispose() {},
    async request(path: string, init?: RequestInit) {
      if (path.startsWith('/config')) return Response.json({ mcp: { graphql: { enabled: false } } })
      if (init?.method === 'POST' && path.startsWith('/mcp?')) connected = JSON.parse(String(init.body)).name
      return Response.json({ graphql: { status: 'disabled' }, [connected]: { status: 'connected' } })
    } }
  let token = ''
  const turn = new OpenCodeFileTurn({ service: f.service, host, server,
    endpoint: 'http://127.0.0.1:9876/mcp/files', appMcpServerName: 'graphql',
    maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS,
    rememberCredential: (issued) => { token = issued } })
  const source = await f.upload()
  const signal = () => AbortSignal.timeout(10_000)
  await turn.prepare({ context: { ...f.context,
    allowedTools: [...f.context.allowedTools, 'files.write_working_copy', 'files.apply_format_edit'] },
    attachments: [], mode: 'write', executionHostId: host.executionHostId, directory: root,
    expiresAt: new Date(f.clock().getTime() + 60_000) }, signal())
  const copy = await turn.createWorkingCopy(token, { commandId: randomUUID(), source, destination: f.scope }, signal())
  const path = await turn.workingCopyLocation(token, copy.value.artifactId)
  return { ...f, host, turn, token, path, artifactId: copy.value.artifactId, signal,
    async close() {
      try { await turn.finish('terminal', signal()) }
      finally { await rm(root, { recursive: true, force: true }) }
    } }
}

it('preserves a concurrent native edit and does not expose a path with unsynchronized server edits', async () => {
  const f = await workingCopy()
  const edit = f.service.writeWorkingCopy.bind(f.service)
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let committed!: () => void
  const commit = new Promise<void>((resolve) => { committed = resolve })
  f.service.writeWorkingCopy = async (token, input) => {
    const result = await edit(token, input)
    committed()
    await hold
    return result
  }
  let pending: Promise<unknown> | undefined
  try {
    pending = f.turn.writeWorkingCopy(f.token, {
      artifactId: f.artifactId, contentBase64: Buffer.from('# server edit\n').toString('base64'),
    })
    const conflict = expect(pending).rejects.toMatchObject({ code: 'FILE_ARTIFACT_CONFLICT' })
    await Promise.race([commit, pending.then(() => { throw new Error('The edit ended before the commit barrier.') })])
    await writeFile(f.path, '# concurrent native edit\n')
    release()
    await conflict
    expect(await readFile(f.path, 'utf8')).toBe('# concurrent native edit\n')
    await expect(f.turn.workingCopyLocation(f.token, f.artifactId))
      .rejects.toMatchObject({ code: 'FILE_ARTIFACT_CONFLICT' })
    await expect(f.turn.publish(f.token, { artifactId: f.artifactId, commandId: randomUUID(),
      scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' }, f.signal()))
      .rejects.toMatchObject({ code: 'FILE_ARTIFACT_CONFLICT' })
    expect(await f.turn.publications()).toEqual([])
    expect(await readFile(f.path, 'utf8')).toBe('# concurrent native edit\n')
  } finally {
    release()
    await Promise.allSettled([pending])
    await f.close()
  }
})

it('synchronizes a committed edit after a lost service reply without applying the edit again', async () => {
  const f = await workingCopy()
  const edit = f.service.applyFormatEdit.bind(f.service)
  let calls = 0
  f.service.applyFormatEdit = async (token, input) => {
    calls++
    await edit(token, input)
    throw new Error('File edit reply lost.')
  }
  try {
    await expect(f.turn.applyFormatEdit(f.token, { artifactId: f.artifactId,
      edit: { kind: 'append_text', text: 'Appended once.\n' } })).rejects.toThrow('File edit reply lost.')
    expect(await f.turn.workingCopyLocation(f.token, f.artifactId)).toBe(f.path)
    expect(await readFile(f.path, 'utf8')).toBe('# original\nAppended once.\n')
    const result = await f.turn.publish(f.token, { artifactId: f.artifactId, commandId: randomUUID(),
      scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' }, f.signal())
    const read = await f.service.read(f.token, { fileId: result.value.file.fileId,
      revisionId: result.value.revision.revisionId })
    expect(read.status).toBe('ready')
    if (read.status === 'ready') expect(Buffer.from(read.contentBase64, 'base64').toString())
      .toBe('# original\nAppended once.\n')
    expect(calls).toBe(1)
  } finally { await f.close() }
})
