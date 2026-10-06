import { randomUUID } from 'node:crypto'
import { open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { AgentFileCreateWorkingCopyResultSchema, AgentFilePublishResultSchema,
  AgentFileWriteWorkingCopyResultSchema } from '@foreman-code/contracts/files'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { fileToolFixture } from '../../../test/support/fileTools.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { FixtureServer, configuration, json } from '../../../test/opencode-fixtures.js'
import { prepareOpenCodeChatFiles, type OpenCodeManagedFileTurn } from '../harnesses/opencodeFiles/chat.js'
import { OpenCodeFileError } from '../harnesses/opencodeFiles/types.js'
import { MainWorkerOpenCodeFiles } from './mainWorkerOpenCodeFiles.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { createWorkerOpenCodeFiles } from './workerOpenCodeFiles.js'
import { WorkerOpenCodeDirectories } from './workerOpenCodeDirectories.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { ALL_FILE_TOOL_NAMES } from '../files/tools/types.js'

async function fixture(readOnly = false) {
  const root = await privateFixtureDirectory('foreman-worker-opencode-files-')
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const files = await fileToolFixture()
  const ref = await files.upload()
  const context = { ...files.context, messageId: 'message-a', allowedTools: [...ALL_FILE_TOOL_NAMES] }
  const identity = { ownerAgentId: 'agent-a', nativeSessionId: context.nativeSessionId,
    nativeTurnId: context.turnId!, clientCorrelationId: 'accepted-file-turn', directory: root,
    configuration: configuration() }
  const request = workerConversationFixture('agent', 'opencode')
  const source: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding: request.binding,
    admissionId: randomUUID(), session: { ...request.session, nativeSessionId: context.nativeSessionId }, prompt: 'Read the accepted file',
    correlationId: identity.clientCorrelationId }
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
  onTestFinished(() => journal.close())
  await journal.conversations.receive(source.binding, request.connection)
  await journal.conversations.reserveCreation(source.binding, 'initial-create', commandInputHash('initial-create'))
  await journal.conversations.bindSession(source.binding, source.session,
    { ...request.nativeOwner, sessionId: source.session.nativeSessionId })
  await journal.conversations.reserveTurn(source.binding, source.correlationId, commandInputHash('accepted-file-turn'))
  const directories = new WorkerOpenCodeDirectories(root, journal.conversations)
  let acknowledgedTurnId: string | undefined
  let token: string | undefined
  let fileToken: string | undefined
  let discoveryCalls = 0
  let clientConnected = false
  let endpoint: string | undefined
  const issue = files.service.sessions.issueForAcceptedSession.bind(files.service.sessions)
  const issuer = vi.spyOn(files.service.sessions, 'issueForAcceptedSession').mockImplementation(async (...args) => {
    fileToken = await issue(...args)
    return fileToken
  })
  onTestFinished(() => issuer.mockRestore())
  const adopt = vi.fn(async () => {})
  const ports = { service: () => files.service,
    sourceHost: () => ({ bootId: randomUUID(), storageRoot: '/main-private-vault' }),
    resolve: async () => ({ context, attachments: [ref] }), adopt }
  let main = new MainWorkerOpenCodeFiles(ports)
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
  const worker = createWorkerOpenCodeFiles({ directories, source: () => source, server,
    signal: AbortSignal.timeout(10000), assertCurrent: async () => {}, assertSourceIsolation: isolation,
    callbacks: { openCodeFiles: async (original, received, action, signal) => {
      if (action.phase === 'authorize-accepted') discoveryCalls++
      expect(original.binding).toEqual(source.binding)
      expect('correlationId' in original && original.correlationId).toBe(source.correlationId)
      return main.handle(received, action, { readOnly, acknowledgedTurnId, signal,
        recovering: original.method === 'conversation.reconcile' })
    } } })
  const client = new Client({ name: 'Worker OpenCode file transport test', version: '1' })
  let managed: OpenCodeManagedFileTurn | undefined
  const connect = async () => {
    await managed!.bridge.connectTools(AbortSignal.timeout(10000))
    if (!clientConnected) {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!), { authProvider: { token: async () => token! } }))
      clientConnected = true
    }
  }
  return { files, ref, root, identity, main, worker, isolation, adopt, client,
    connect, discoveryCalls: () => discoveryCalls,
    async prepare() {
      managed = await prepareOpenCodeChatFiles(worker.adapter, identity, server, 'foreman-code', AbortSignal.timeout(10000))
      return managed!
    },
    async acknowledge() {
      await connect()
      managed!.bridge.submissionAttempted()
      acknowledgedTurnId = identity.nativeTurnId
      await managed!.bridge.acknowledge(AbortSignal.timeout(10000))
      return fileToken!
    },
    async recover() {
      await main.close()
      main = new MainWorkerOpenCodeFiles(ports)
      const recovery: WorkerConversationRpcRequest = { method: 'conversation.reconcile', binding: source.binding,
        session: source.session, correlationId: source.correlationId, admissionId: randomUUID(),
        sessionMode: readOnly ? 'plan' : 'regular' }
      await worker.recover(recovery, identity.nativeTurnId, AbortSignal.timeout(10000))
      const connection = token
      const renewed = fileToken!
      await worker.recover(recovery, identity.nativeTurnId, AbortSignal.timeout(10000))
      expect(fileToken).toBe(renewed)
      expect(token).toBe(connection)
      return renewed
    },
    async close() {
      const errors: unknown[] = []
      for (const close of [() => client.close(),
        async () => { await managed?.nativeProcessClosed(AbortSignal.timeout(10000)) },
        () => worker.close(), () => main.close(), () => journal.close(), () => rm(root, { recursive: true, force: true })]) {
        try { await close() }
        catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Worker file fixture cleanup failed.')
    } }
}

it('connects scoped discovery before acknowledgement and holds file bytes until the native input is accepted', async () => {
  const f = await fixture()
  const read = vi.spyOn(f.files.service, 'read')
  try {
    await f.prepare()
    await f.connect()
    expect((await f.client.listTools()).tools.some(tool => tool.name === 'files.read')).toBe(true)
    const before = f.discoveryCalls()
    let settled = false
    const pending = f.client.callTool({ name: 'files.read', arguments: { ...f.ref, offset: 0, length: 65536 } })
    void pending.then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => expect(f.discoveryCalls()).toBeGreaterThan(before))
    expect(settled).toBe(false)
    expect(read).not.toHaveBeenCalled()
    await f.acknowledge()
    expect((await pending).structuredContent).toMatchObject({ status: 'ready',
      contentBase64: Buffer.from('# original\n').toString('base64') })
    expect(read).toHaveBeenCalledOnce()
  } finally { read.mockRestore(); await f.close() }
})

it('rebinds Main authority on the same listener and copies, revokes the old credential and publishes retained edits', async () => {
  const f = await fixture()
  try {
    const managed = await f.prepare()
    const original = await f.acknowledge()
    const copy = await f.client.callTool({ name: 'files.create_working_copy', arguments: {
      commandId: randomUUID(), source: f.ref, destination: f.files.scope,
    } })
    const artifactId = AgentFileCreateWorkingCopyResultSchema.parse(copy.structuredContent).value.artifactId
    const path = await managed.bridge.workingCopyLocation(original, artifactId)
    await writeFile(path, '# edits before reconnection\n')
    const roots = await readdir(join(f.root, 'opencode-chat-files'))
    const renewed = await f.recover()
    expect(renewed).not.toBe(original)
    await expect(f.files.sessions.authenticate(original)).rejects.toMatchObject({ status: 401 })
    expect(await managed.bridge.workingCopyLocation(renewed, artifactId)).toBe(path)
    expect(await readFile(path, 'utf8')).toBe('# edits before reconnection\n')
    expect(await readdir(join(f.root, 'opencode-chat-files'))).toEqual(roots)
    const result = await f.client.callTool({ name: 'files.publish_result', arguments: {
      commandId: randomUUID(), artifactId, scope: f.files.scope, filename: 'reconnected.md', mediaType: 'text/markdown',
    } })
    const published = AgentFilePublishResultSchema.parse(result.structuredContent)
    const read = await f.files.service.read(renewed, { fileId: published.value.file.fileId,
      revisionId: published.value.revision.revisionId, offset: 0, length: 65536 })
    expect(read.status === 'ready' && Buffer.from(read.contentBase64, 'base64').toString('utf8'))
      .toBe('# edits before reconnection\n')
  } finally { await f.close() }
})

it('keeps recovered Plan credentials read-only', async () => {
  const f = await fixture(true)
  try {
    await f.prepare()
    await f.acknowledge()
    await f.recover()
    expect((await f.client.listTools()).tools.map(tool => tool.name)).toEqual(['files.list', 'files.read'])
    expect(f.files.tools.artifacts.size).toBe(0)
  } finally { await f.close() }
})

it('copies a file-tool edit across bounded Main snapshot ranges and publishes subsequent native edits', async () => {
  const f = await fixture()
  try {
    const managed = await f.prepare()
    const credential = await f.acknowledge()
    const copied = await f.client.callTool({ name: 'files.create_working_copy', arguments: {
      commandId: randomUUID(), source: f.ref, destination: f.files.scope,
    } })
    const artifactId = AgentFileCreateWorkingCopyResultSchema.parse(copied.structuredContent).value.artifactId
    const edited = `# file-tool edit\n${'x'.repeat(70000)}\n`
    const result = await f.client.callTool({ name: 'files.write_working_copy', arguments: {
      artifactId, contentBase64: Buffer.from(edited).toString('base64'),
    } })
    AgentFileWriteWorkingCopyResultSchema.parse(result.structuredContent)
    const path = await managed.bridge.workingCopyLocation(credential, artifactId)
    expect(await readFile(path, 'utf8')).toBe(edited)
    await writeFile(path, '# native edit after file-tool edit\n')
    const publication = await f.client.callTool({ name: 'files.publish_result', arguments: {
      commandId: randomUUID(), artifactId, scope: f.files.scope, filename: 'edited.md', mediaType: 'text/markdown',
    } })
    const saved = AgentFilePublishResultSchema.parse(publication.structuredContent)
    const read = await f.files.service.read(credential, { fileId: saved.value.file.fileId,
      revisionId: saved.value.revision.revisionId, offset: 0, length: 65536 })
    expect(read.status === 'ready' && Buffer.from(read.contentBase64, 'base64').toString('utf8'))
      .toBe('# native edit after file-tool edit\n')
  } finally { await f.close() }
})

it('preserves displaced native and file-tool edits through Main before releasing working copies', async () => {
  const f = await fixture()
  try {
    const managed = await f.prepare()
    const credential = await f.acknowledge()
    const copied = await f.client.callTool({ name: 'files.create_working_copy', arguments: {
      commandId: randomUUID(), source: f.ref, destination: f.files.scope,
    } })
    const artifactId = AgentFileCreateWorkingCopyResultSchema.parse(copied.structuredContent).value.artifactId
    const path = await managed.bridge.workingCopyLocation(credential, artifactId)
    const native = await open(path, 'r+')
    try {
      const edited = await f.client.callTool({ name: 'files.write_working_copy', arguments: {
        artifactId, contentBase64: Buffer.from('# file-tool edit\n').toString('base64'),
      } })
      AgentFileWriteWorkingCopyResultSchema.parse(edited.structuredContent)
      const bytes = Buffer.from('# displaced native edit\n')
      await native.truncate(0)
      await native.write(bytes, 0, bytes.length, 0)
      await native.sync()
      const published = await f.client.callTool({ name: 'files.publish_result', arguments: {
        commandId: randomUUID(), artifactId, scope: f.files.scope, filename: 'kept.md', mediaType: 'text/markdown',
      } })
      AgentFilePublishResultSchema.parse(published.structuredContent)
      const contents: string[] = []
      for (const ref of await f.files.service.publishedForTurn(credential)) {
        const read = await f.files.service.read(credential, { ...ref, offset: 0, length: 65536 })
        if (read.status === 'ready') contents.push(Buffer.from(read.contentBase64, 'base64').toString('utf8'))
      }
      expect(contents).toContain('# displaced native edit\n')
      expect(contents).toContain('# file-tool edit\n')
    } finally { await native.close() }
    await managed.finish('terminal', AbortSignal.timeout(10000))
    expect(await readdir(join(f.root, 'opencode-chat-files'))).toEqual([])
  } finally { await f.close() }
})

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
    await expect(f.client.callTool({ name: 'files.create_working_copy', arguments: {
      commandId: randomUUID(), source: f.ref, destination: f.files.scope,
    } })).rejects.toMatchObject({ name: 'ProtocolError', code: -32602 })
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
