import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import { DomainError } from '../src/modules/errors.js'
import { registerFileToolsMcp } from '../src/modules/files/tools/mcp.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import { createOpenCodeFileMcpFacade } from '../src/modules/harnesses/opencodeFiles/facade.js'
import { LocalOpenCodeExecutionFiles } from '../src/modules/harnesses/opencodeFiles/host.js'
import { OpenCodeFileTurn } from '../src/modules/harnesses/opencodeFiles/turn.js'
import { fileToolFixture } from './support/fileTools.js'

/** Real FIL-05 domain + authenticated MCP surface; fake ONLY the native server and byte store. */
describe('FIL-09 scoped OpenCode MCP facade', () => {
  it('rejects a configured or connected legacy App MCP server during file chat', async () => {
    const f = await fileToolFixture()
    const host = new LocalOpenCodeExecutionFiles({ executionHostId: 'fixture-host', root: tmpdir(), maxFileBytes: MAX_FILE_BYTES,
      async assertSourceIsolation() {} })
    const config: Record<string, { enabled: boolean }> = { 'foreman-code': { enabled: false } }
    const status: Record<string, { status: string }> = { 'foreman-code': { status: 'disabled' } }
    const native = {
      expectedVersion: '1.18.31', async ensure() {}, async dispose() {},
      async request(path: string, init?: RequestInit) {
        const route = new URL(path, 'http://127.0.0.1').pathname
        if (route === '/config') return Response.json({ mcp: config })
        if (route === '/mcp' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { name: string }
          status[body.name] = { status: 'connected' }
        }
        if (route.endsWith('/disconnect')) {
          const name = route.split('/')[2]!
          status[name] = { status: 'disabled' }
        }
        return Response.json(status)
      },
    }
    const prepare = async () => {
      const turn = new OpenCodeFileTurn({ service: f.service, host, server: native,
        endpoint: 'http://127.0.0.1:9876/mcp/files', appMcpServerName: 'foreman-code',
        maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS })
      const signal = AbortSignal.timeout(10_000)
      try {
        await turn.prepare({ context: f.context, attachments: [], mode: 'write', directory: tmpdir(),
          executionHostId: host.executionHostId, expiresAt: new Date(f.clock().getTime() + 60_000) }, signal)
      } finally {
        await turn.finish('definite_rejection', signal)
      }
    }
    await expect(prepare()).resolves.toBeUndefined()
    for (const name of ['graphql-app', 'graphql-operator']) {
      config[name] = { enabled: true }
      await expect(prepare()).rejects.toMatchObject({ code: 'FILE_CHAT_ISOLATION_REQUIRED' })
      config[name] = { enabled: false }
      status[name] = { status: 'connected' }
      await expect(prepare()).rejects.toMatchObject({ code: 'FILE_CHAT_ISOLATION_REQUIRED' })
      status[name] = { status: 'disabled' }
    }
    await expect(prepare()).resolves.toBeUndefined()
  })

  it('synchronizes tool and native edits, publishes their bytes and preserves credential and scope denials', async () => {
    const f = await fileToolFixture()
    const root = await mkdtemp(join(tmpdir(), 'fil09-mcp-'))
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
      .send({ error: 'Request denied.' }))
    let token = '', connected = ''
    const issue = f.sessions.issueForAcceptedSession.bind(f.sessions)
    vi.spyOn(f.sessions, 'issueForAcceptedSession').mockImplementation(async (context, expiry) => {
      token = await issue(context, expiry); return token
    })
    const context: FileToolContext = { ...f.context, nativeSessionId: 'opencode-test', turnId: randomUUID(),
      allowedTools: [...f.context.allowedTools, 'files.write_working_copy', 'files.apply_format_edit'] }
    const host = new LocalOpenCodeExecutionFiles({ executionHostId: 'fixture-host', root, maxFileBytes: MAX_FILE_BYTES,
      preserveVersion: (input, signal) => f.service.preserveAccepted(context, input, signal),
      async assertSourceIsolation() { /* MemoryBytes contains every source; there are no filesystem source paths. */ } })
    const native = {
      expectedVersion: '1.18.31', generation: 1, async ensure() {}, async dispose() {},
      async request(path: string, init?: RequestInit) {
        const url = new URL(path, 'http://127.0.0.1')
        if (url.pathname === '/config') return Response.json({ mcp: { 'foreman-code': { enabled: false } } })
        if (url.pathname.endsWith('/disconnect')) return Response.json(true)
        if (init?.method === 'POST') connected = JSON.parse(init.body as string).name
        return Response.json({ 'foreman-code': { status: 'disabled' }, ...(connected ? { [connected]: { status: 'connected' } } : {}) })
      },
    }
    const turn = new OpenCodeFileTurn({ service: f.service, host, server: native,
      endpoint: 'http://127.0.0.1:9876/mcp/files', appMcpServerName: 'foreman-code',
      maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS })
    registerFileToolsMcp(app, createOpenCodeFileMcpFacade(f.service, () => turn))
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const call = async (name: string, input: unknown, credential = token) => {
      const response = await fetch(new URL('/mcp/files', address), { method: 'POST',
        headers: { authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream',
          'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) })
      const text = await response.text()
      const data = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? text
      return { status: response.status, body: JSON.parse(data) }
    }
    try {
      const source = await f.upload()
      await turn.prepare({ context,
        attachments: [], mode: 'write', directory: root, executionHostId: 'fixture-host',
        expiresAt: new Date(f.clock().getTime() + 3_600_000) }, AbortSignal.timeout(10_000))
      const copy = await call('files.create_working_copy', { commandId: randomUUID(), source, destination: f.scope })
      expect(copy.status).toBe(200)
      const artifactId = copy.body.result.structuredContent.value.artifactId
      const annotation = copy.body.result.content.map((part: { text?: string }) => part.text)
        .find((text: string | undefined) => text?.includes('"path"'))
      const path = JSON.parse(annotation!).path
      expect(path).toBe(await turn.workingCopyLocation(token, artifactId))
      const written = await call('files.write_working_copy', {
        artifactId, contentBase64: Buffer.from('# edited by file tools\n').toString('base64'),
      })
      expect(written.body.result.isError).not.toBe(true)
      expect(await readFile(path, 'utf8')).toBe('# edited by file tools\n')
      const writtenRevision = written.body.result.structuredContent.revisionId
      const formatted = await call('files.apply_format_edit', {
        artifactId, baseRevisionId: writtenRevision, edit: { kind: 'append_text', text: 'Appended by file tools.\n' },
      })
      expect(formatted.body.result.isError).not.toBe(true)
      expect(await readFile(path, 'utf8')).toBe('# edited by file tools\nAppended by file tools.\n')
      expect(await turn.workingCopyLocation(token, artifactId)).toBe(path)
      const stale = await call('files.write_working_copy', {
        artifactId, baseRevisionId: writtenRevision, contentBase64: Buffer.from('stale').toString('base64'),
      })
      expect(stale.body.result.isError).toBe(true)
      expect(await turn.workingCopyLocation(token, artifactId)).toBe(path)
      expect(await readFile(path, 'utf8')).toBe('# edited by file tools\nAppended by file tools.\n')
      await writeFile(path, '# native intermediate edit\n')
      const combined = await call('files.apply_format_edit', {
        artifactId, edit: { kind: 'append_text', text: 'Appended after the native edit.\n' },
      })
      expect(combined.body.result.isError).not.toBe(true)
      expect(await readFile(path, 'utf8')).toBe('# native intermediate edit\nAppended after the native edit.\n')
      await writeFile(path, '# edited by native OpenCode\n')
      const input = { commandId: randomUUID(), artifactId, scope: f.scope, filename: 'returned.md', mediaType: 'text/markdown' }
      const published = await call('files.publish_result', input)
      expect(published.body.result.isError).not.toBe(true)
      const revision = published.body.result.structuredContent.value.revision
      const read = await f.service.read(token, { fileId: revision.fileId, revisionId: revision.revisionId })
      expect(read.status).toBe('ready')
      if (read.status === 'ready') expect(Buffer.from(read.contentBase64, 'base64').toString()).toBe('# edited by native OpenCode\n')
      expect((await call('files.publish_result', input)).body.result.structuredContent.replayed).toBe(true)
      expect(await turn.publications()).toEqual([{ fileId: revision.fileId, revisionId: revision.revisionId }])
      const original = await f.service.read(token, source)
      expect(original.status).toBe('ready')
      if (original.status === 'ready') expect(Buffer.from(original.contentBase64, 'base64').toString()).toBe('# original\n')
      expect((await call('files.read', source, f.token)).status).toBe(401)
      expect((await call('files.write_working_copy', {
        artifactId, contentBase64: Buffer.from('foreign').toString('base64'),
      }, f.token)).status).toBe(401)
      const permanent = await call('files.publish_result', { ...input, commandId: randomUUID(),
        scope: { kind: 'workspace_reference', workspaceId: 'workspace-a' } })
      expect(permanent.body.result.isError).toBe(true)
      const retained = await call('files.create_working_copy', {
        commandId: randomUUID(), source, destination: f.scope,
      })
      const retainedId = retained.body.result.structuredContent.value.artifactId
      const retainedPath = await turn.workingCopyLocation(token, retainedId)
      const writer = await open(retainedPath, 'r+')
      try {
        const edit = await call('files.write_working_copy', { artifactId: retainedId,
          contentBase64: Buffer.from('# MCP edit\n').toString('base64') })
        expect(edit.body.result.isError).not.toBe(true)
        await writer.truncate(0)
        await writer.write(Buffer.from('# displaced native edit\n'), 0,
          Buffer.byteLength('# displaced native edit\n'), 0)
        const result = await call('files.publish_result', { ...input, artifactId: retainedId, commandId: randomUUID() })
        expect(result.body.result.isError).not.toBe(true)
        const contents: string[] = []
        for (const ref of await turn.publications()) {
          const read = await call('files.read', ref)
          expect(read.body.result.isError).not.toBe(true)
          contents.push(Buffer.from(read.body.result.structuredContent.contentBase64, 'base64').toString())
        }
        expect(contents).toContain('# MCP edit\n')
        expect(contents).toContain('# displaced native edit\n')
      } finally {
        await writer.close()
      }
      f.denyWrites()
      const denied = await call('files.publish_result', { ...input, commandId: randomUUID() })
      expect(denied.body.result.isError).toBe(true)
      expect((await call('files.write_working_copy', {
        artifactId, contentBase64: Buffer.from('denied').toString('base64'),
      })).body.result.isError).toBe(true)
      expect(await readFile(path, 'utf8')).toBe('# edited by native OpenCode\n')
      await turn.finish('terminal', AbortSignal.timeout(10_000))
      expect((await call('files.read', source)).status).toBe(401)
    } finally {
      await turn.finish('terminal', AbortSignal.timeout(10_000))
      await app.close(); await rm(root, { recursive: true, force: true })
    }
  })
})
