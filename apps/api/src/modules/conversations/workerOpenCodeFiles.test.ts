import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { AgentFileCreateWorkingCopyResultSchema, AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { fileToolFixture } from '../../../test/support/fileTools.js'
import { FixtureServer, configuration, json } from '../../../test/opencode-fixtures.js'
import { prepareOpenCodeChatFiles, type OpenCodeManagedFileTurn } from '../harnesses/opencodeFiles/chat.js'
import { OpenCodeFileError } from '../harnesses/opencodeFiles/types.js'
import { MainWorkerOpenCodeFiles } from './mainWorkerOpenCodeFiles.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { createWorkerOpenCodeFiles } from './workerOpenCodeFiles.js'

async function fixture(readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), 'foreman-worker-opencode-files-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const files = await fileToolFixture()
  const ref = await files.upload()
  const context = { ...files.context, messageId: 'message-a' }
  const identity = { ownerAgentId: 'agent-a', nativeSessionId: context.nativeSessionId,
    nativeTurnId: context.turnId!, clientCorrelationId: 'accepted-file-turn', directory: root,
    configuration: configuration() }
  const request = workerConversationFixture('agent', 'opencode')
  const source: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding: request.binding,
    admissionId: randomUUID(), session: request.session, prompt: 'Read the accepted file',
    correlationId: identity.clientCorrelationId }
  let acknowledgedTurnId: string | undefined
  let token: string | undefined
  let endpoint: string | undefined
  const adopt = vi.fn(async () => {})
  const main = new MainWorkerOpenCodeFiles({ service: () => files.service,
    sourceHost: () => ({ bootId: randomUUID(), storageRoot: '/main-private-vault' }),
    resolve: async () => ({ context, attachments: [ref] }), adopt })
  const server = new FixtureServer()
  server.config = { mcp: { 'foreman-code': { enabled: false }, graphql: { enabled: false } } }
  server.mcp = { 'foreman-code': { status: 'disabled' }, graphql: { status: 'disabled' } }
  server.beforeRequest = (path, init) => {
    if (new URL(path, 'http://fixture.invalid').pathname === '/mcp' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string; config: { url: string; headers: { Authorization: string } } }
      endpoint = body.config.url
      token = body.config.headers.Authorization.slice('Bearer '.length)
      server.mcp[body.name] = { status: 'connected' }
      return json(server.mcp)
    }
    return undefined
  }
  // Only native transport/OS isolation and persistence are recorded; no installed qualification is claimed.
  const isolation = vi.fn(async () => {})
  const worker = createWorkerOpenCodeFiles({ stateDirectory: root, source: () => source, server,
    signal: AbortSignal.timeout(10000), assertCurrent: async () => {}, assertSourceIsolation: isolation,
    callbacks: { openCodeFiles: async (original, received, action, signal) => {
      expect(original).toEqual(source)
      return main.handle(received, action, { readOnly, acknowledgedTurnId, signal })
    } } })
  const client = new Client({ name: 'Worker OpenCode file transport test', version: '1' })
  let managed: OpenCodeManagedFileTurn | undefined
  return { files, ref, root, identity, main, worker, isolation, adopt, client,
    async prepare() {
      managed = await prepareOpenCodeChatFiles(worker.adapter, identity, server, 'foreman-code', AbortSignal.timeout(10000))
      return managed!
    },
    async acknowledge() {
      managed!.bridge.submissionAttempted()
      acknowledgedTurnId = identity.nativeTurnId
      await managed!.bridge.acknowledge(AbortSignal.timeout(10000))
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!), { authProvider: { token: async () => token! } }))
      return token!
    },
    async close() {
      const errors: unknown[] = []
      for (const close of [() => client.close(),
        async () => { await managed?.nativeProcessClosed(AbortSignal.timeout(10000)) },
        () => worker.close(), () => main.close(), () => rm(root, { recursive: true, force: true })]) {
        try { await close() }
        catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Worker file fixture cleanup failed.')
    } }
}

it('carries accepted inputs and native working copies through the file-only MCP listener and Main publication service', async () => {
  const f = await fixture()
  try {
    const managed = await f.prepare()
    expect(f.isolation).toHaveBeenCalledOnce()
    expect(f.files.tools.sessions.size).toBe(1)
    const token = await f.acknowledge()
    const listed = await f.client.listTools()
    expect(listed.tools.every(tool => tool.name.startsWith('files.'))).toBe(true)
    const read = await f.client.callTool({ name: 'files.read', arguments: { ...f.ref, offset: 0, length: 65536 } })
    expect(read.structuredContent).toMatchObject({ status: 'ready', contentBase64: Buffer.from('# original\n').toString('base64') })
    const copy = await f.client.callTool({ name: 'files.create_working_copy', arguments: {
      commandId: randomUUID(), source: f.ref, destination: f.files.scope,
    } })
    const artifact = AgentFileCreateWorkingCopyResultSchema.parse(copy.structuredContent).value.artifactId
    const path = await managed.bridge.workingCopyLocation(token, artifact)
    expect(await readFile(path, 'utf8')).toBe('# original\n')
    await writeFile(path, '# result from worker\n')
    const publication = { commandId: randomUUID(), artifactId: artifact, scope: f.files.scope,
      filename: 'result.md', mediaType: 'text/markdown' }
    const result = await f.client.callTool({ name: 'files.publish_result', arguments: publication })
    const published = AgentFilePublishResultSchema.parse(result.structuredContent)
    const persisted = await f.files.service.read(token, { fileId: published.value.file.fileId,
      revisionId: published.value.revision.revisionId, offset: 0, length: 65536 })
    expect(persisted.status === 'ready' && Buffer.from(persisted.contentBase64, 'base64').toString('utf8'))
      .toBe('# result from worker\n')
    expect(f.adopt).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'message-a' }))
    await managed.finish('terminal', AbortSignal.timeout(10000))
    expect(await readdir(join(f.root, 'opencode-chat-files'))).toEqual([])
    await expect(f.files.service.sessions.authenticate(token)).rejects.toMatchObject({ status: 401 })
  } finally { await f.close() }
})

it('advertises only read tools for Plan and cannot publish through the worker listener', async () => {
  const f = await fixture(true)
  try {
    await f.prepare()
    await f.acknowledge()
    expect((await f.client.listTools()).tools.map(tool => tool.name)).toEqual(['files.list', 'files.read'])
    const denied = await f.client.callTool({ name: 'files.create_working_copy', arguments: {
      commandId: randomUUID(), source: f.ref, destination: f.files.scope,
    } })
    expect(denied.isError).toBe(true)
    expect(f.files.tools.artifacts.size).toBe(0)
  } finally { await f.close() }
})

it('cleans the private listener without issuing tools when source isolation fails before native submission', async () => {
  const f = await fixture()
  try {
    f.isolation.mockRejectedValue(new OpenCodeFileError('FILE_SOURCE_WRITABLE', 'The source is writable.'))
    await expect(f.prepare()).rejects.toMatchObject({ code: 'FILE_SOURCE_WRITABLE' })
    expect(f.files.tools.sessions.size).toBe(1)
    expect(await readdir(join(f.root, 'opencode-chat-files'))).toEqual([])
  } finally { await f.close() }
})
