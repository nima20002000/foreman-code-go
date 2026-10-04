import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import { DomainError } from '../src/modules/errors.js'
import { registerFileToolsMcp } from '../src/modules/files/tools/mcp.js'
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
    const config: Record<string, { enabled: boolean }> = { graphql: { enabled: false } }
    const status: Record<string, { status: string }> = { graphql: { status: 'disabled' } }
    const native = {
      expectedVersion: '1.18.31', async ensure() {}, async dispose() {},
      async request(path: string) {
        return Response.json(new URL(path, 'http://127.0.0.1').pathname === '/config' ? { mcp: config } : status)
      },
    }
    const turn = new OpenCodeFileTurn({ service: f.service, host, server: native,
      endpoint: 'http://127.0.0.1:9876/mcp/files', appMcpServerName: 'graphql',
      maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS })
    Object.assign(turn, { accepted: { directory: tmpdir() } })
    const signal = AbortSignal.timeout(10_000)
    await expect(turn['assertChat'](signal)).resolves.toBeUndefined()
    for (const name of ['graphql-app', 'graphql-operator']) {
      config[name] = { enabled: true }
      await expect(turn['assertChat'](signal)).rejects.toMatchObject({ code: 'FILE_CHAT_ISOLATION_REQUIRED' })
      config[name] = { enabled: false }
      status[name] = { status: 'connected' }
      await expect(turn['assertChat'](signal)).rejects.toMatchObject({ code: 'FILE_CHAT_ISOLATION_REQUIRED' })
      status[name] = { status: 'disabled' }
    }
    await expect(turn['assertChat'](signal)).resolves.toBeUndefined()
  })

  it('copies, annotates the native path, publishes edited bytes, denies foreign credentials and keeps permanent writes forbidden', async () => {
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
    const host = new LocalOpenCodeExecutionFiles({ executionHostId: 'fixture-host', root, maxFileBytes: MAX_FILE_BYTES,
      async assertSourceIsolation() { /* MemoryBytes contains every source; there are no filesystem source paths. */ } })
    const native = {
      expectedVersion: '1.18.31', generation: 1, async ensure() {}, async dispose() {},
      async request(path: string, init?: RequestInit) {
        const url = new URL(path, 'http://127.0.0.1')
        if (url.pathname === '/config') return Response.json({ mcp: { graphql: { enabled: false } } })
        if (url.pathname.endsWith('/disconnect')) return Response.json(true)
        if (init?.method === 'POST') connected = JSON.parse(init.body as string).name
        return Response.json({ graphql: { status: 'disabled' }, ...(connected ? { [connected]: { status: 'connected' } } : {}) })
      },
    }
    const turn = new OpenCodeFileTurn({ service: f.service, host, server: native,
      endpoint: 'http://127.0.0.1:9876/mcp/files', appMcpServerName: 'graphql',
      maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS })
    registerFileToolsMcp(app, createOpenCodeFileMcpFacade(f.service, () => turn))
    const call = async (name: string, input: unknown, credential = token) => {
      const response = await app.inject({ method: 'POST', url: '/mcp/files',
        headers: { host: 'localhost', authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } } })
      const data = response.body.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? response.body
      return { status: response.statusCode, body: JSON.parse(data) }
    }
    try {
      const source = await f.upload()
      await turn.prepare({ context: { ...f.context, nativeSessionId: 'opencode-test', turnId: randomUUID() },
        attachments: [], mode: 'write', directory: root, executionHostId: 'fixture-host',
        expiresAt: new Date(f.clock().getTime() + 3_600_000) }, AbortSignal.timeout(10_000))
      const copy = await call('files.create_working_copy', { commandId: randomUUID(), source, destination: f.scope })
      expect(copy.status).toBe(200)
      const artifactId = copy.body.result.structuredContent.value.artifactId
      const annotation = copy.body.result.content.map((part: { text?: string }) => part.text)
        .find((text: string | undefined) => text?.includes('"path"'))
      const path = JSON.parse(annotation!).path
      expect(path).toBe(await turn.workingCopyLocation(token, artifactId))
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
      const permanent = await call('files.publish_result', { ...input, commandId: randomUUID(),
        scope: { kind: 'workspace_reference', workspaceId: 'workspace-a' } })
      expect(permanent.body.result.isError).toBe(true)
      f.denyWrites()
      const denied = await call('files.publish_result', { ...input, commandId: randomUUID() })
      expect(denied.body.result.isError).toBe(true)
      await turn.finish('terminal', AbortSignal.timeout(10_000))
      expect((await call('files.read', source)).status).toBe(401)
    } finally {
      await turn.finish('terminal', AbortSignal.timeout(10_000))
      await app.close(); await rm(root, { recursive: true, force: true })
    }
  })
})
