import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'vitest'
import type { FileMcpService } from '../src/modules/files/tools/mcp.js'
import type { OpenCodeChatFileBinding, OpenCodeChatFiles } from '../src/modules/harnesses/opencodeFiles/chat.js'
import { OpenCodeNativeDeliveryError, OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { FixtureServer, configuration, errorCode, json, request } from './opencode-fixtures.js'
import { createChatFileBackend, fileContext, fileScope, hasFileCode } from './support/opencodeChatFileFixture.js'

async function fixture(mode: 'read' | 'write' = 'write', editTools = false) {
  const backend = createChatFileBackend()
  const server = new FixtureServer()
  server.config = { mcp: { graphql: { enabled: false } } }
  server.mcp = { graphql: { status: 'disabled' } }
  const attachment = backend.add('image bytes stay out of prompt', 'image/png', 'image #.png')
  const correlationId = 'chat:conversation-a:accepted-a'
  let facade: FileMcpService | undefined, unmounts = 0, resolutions = 0
  let foreign = false, noAttachments = false, connectFailure = false, rejectPrompt = false
  let promptHook: FixtureServer['onPrompt']
  server.onPrompt = async (id, body) => {
    // An explicit unfinished assistant part lets the observer yield while tools
    // are exercised. Do not rely on the transport surfacing user-message events.
    const partial = server.assistant(String(body.messageID), 'working', undefined, false, id)
    server.emit('message.updated', { info: partial.info })
    for (const part of partial.parts) server.emit('message.part.updated', { part })
    await promptHook?.(id, body)
  }
  server.beforeRequest = (path, init) => {
    const route = new URL(path, 'http://fixture.invalid').pathname
    if (route.endsWith('/abort')) backend.audit.push('abort')
    if (route.endsWith('/prompt_async') && rejectPrompt) return json({ error: 'fixture definite rejection' }, 400)
    if (route === '/mcp' && init.method === 'POST') {
      backend.audit.push('connect')
      const body = object(JSON.parse(String(init.body)))
      if (connectFailure) return json({ error: 'fixture registration unavailable' }, 503)
      server.mcp[String(body.name)] = { status: 'connected' }
      return json(server.mcp)
    }
    return undefined
  }
  const runtime: OpenCodeChatFiles = {
    async resolve(identity) {
      resolutions++
      if (noAttachments) return undefined
      const context = fileContext({ nativeSessionId: identity.nativeSessionId,
        turnId: foreign ? 'a-foreign-native-turn' : identity.nativeTurnId, allowMutation: mode === 'write',
        ...(editTools ? { allowedTools: [...fileContext().allowedTools, 'files.write_working_copy', 'files.apply_format_edit'] } : {}) })
      const binding: OpenCodeChatFileBinding = {
        admission: { context, attachments: [attachment], expiresAt: new Date(Date.now() + 60_000),
          executionHostId: 'execution-b', directory: identity.directory, mode },
        options: { service: backend.service, host: backend.host, endpoint: 'http://127.0.0.1:9876/mcp/files',
          maxFileBytes: 25 * 1024 * 1024, maxAttachments: 10 },
        read: backend.readAccepted(context), adoptPublished: backend.adoptPublished,
        async mount(value) {
          facade = value
          return async () => { unmounts++; facade = undefined }
        },
      }
      return binding
    },
  }
  const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1',
    appMcpServerName: 'graphql', appMcpAccess: 'none', chatFiles: runtime })
  const harness = { ...configuration(), ...(mode === 'read' ? { nativeAgent: 'plan' } : {}) }
  const session = await manager.createSession({ request: request(harness), environment: { agentId: 'agent-1', variables: {} } })
  const iterators: AsyncIterator<unknown>[] = []
  const start = (onSubmitted?: (id: string) => Promise<void>) => {
    const iterator = manager.startTurn(session, { prompt: 'hello', clientCorrelationId: correlationId,
      ...(onSubmitted ? { onSubmitted } : {}) })[Symbol.asyncIterator]()
    iterators.push(iterator)
    return iterator
  }
  const observe = () => {
    const iterator = manager.observeTurn(session, correlationId)[Symbol.asyncIterator]()
    iterators.push(iterator)
    return iterator
  }
  return { backend, server, manager, session, attachment, correlationId, start, observe,
    get facade() { assert(facade); return facade }, get unmounts() { return unmounts }, get resolutions() { return resolutions },
    get prompts() { return server.calls.filter((call) => call.path.includes('/prompt_async')) },
    foreignTurn() { foreign = true }, withoutAttachments() { noAttachments = true },
    failConnect() { connectFailure = true }, rejectPrompt() { rejectPrompt = true },
    onPrompt(hook: FixtureServer['onPrompt']) { promptHook = hook },
    async close() {
      try { await manager.dispose() } finally { for (const iterator of iterators) await iterator.return?.() }
    },
  }
}
async function drain(iterator: AsyncIterator<unknown>) { while (!(await iterator.next()).done) { /* drain existing observer */ } }
async function publish(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.facade.createWorkingCopy(f.backend.token, {
    commandId: randomUUID(), source: f.attachment, destination: fileScope,
  })
  const id = created.value.artifactId
  f.backend.hostFiles.get(id)!.bytes = Buffer.from('# edited output\n')
  return f.facade.publish(f.backend.token, { commandId: randomUUID(), artifactId: id,
    filename: 'result.md', mediaType: 'text/markdown', scope: fileScope })
}

describe('FIL-09a production OpenCodeNativeSessionManager with existing fake server', () => {
  it('dispatches FIL-05b edits only through the owned file credential', async () => {
    const f = await fixture('write', true)
    try {
      const calls: string[] = []
      Object.assign(f.backend.service, {
        writeWorkingCopy: async (token: string, input: { artifactId: string }) => {
          await f.backend.service.sessions.authenticate(token, 'files.write_working_copy')
          calls.push(`write:${input.artifactId}`)
          return { artifactId: input.artifactId }
        },
        applyFormatEdit: async (token: string, input: { artifactId: string }) => {
          await f.backend.service.sessions.authenticate(token, 'files.apply_format_edit')
          calls.push(`format:${input.artifactId}`)
          return { artifactId: input.artifactId }
        },
      })
      const iterator = f.start(); await iterator.next()
      const artifactId = (await f.facade.createWorkingCopy(f.backend.token, {
        commandId: randomUUID(), source: f.attachment, destination: fileScope,
      })).value.artifactId
      await f.facade.writeWorkingCopy!(f.backend.token, { artifactId, contentBase64: Buffer.from('new').toString('base64') })
      await f.facade.applyFormatEdit!(f.backend.token, { artifactId, edit: { kind: 'append_text', text: 'more' } })
      await assert.rejects(() => f.facade.writeWorkingCopy!(`gql_file_${'X'.repeat(43)}`,
        { artifactId, contentBase64: Buffer.from('new').toString('base64') }), hasFileCode('FILE_SESSION_INVALID'))
      assert.deepEqual(calls, [`write:${artifactId}`, `format:${artifactId}`])
      f.backend.hostFiles.get(artifactId)!.bytes = Buffer.from('changed on host')
      await assert.rejects(() => f.facade.publish(f.backend.token, {
        commandId: randomUUID(), artifactId, filename: 'result.md', mediaType: 'text/markdown', scope: fileScope,
      }), hasFileCode('FILE_ARTIFACT_CONFLICT'))
      f.server.complete(f.correlationId); await drain(iterator)
    } finally { await f.close() }
  })
  it('sends prepared image parts, then issues tools only after positive native acknowledgement', async () => {
    const f = await fixture()
    try {
      f.onPrompt((_id, body) => {
        assert.equal(f.backend.issued.length, 0)
        assert.equal(f.backend.audit.includes('connect'), false)
        const parts = body.parts as Record<string, unknown>[]
        assert.equal(parts[1]?.type, 'file'); assert.equal(parts[1]?.mime, 'image/png')
        assert.match(String(parts[1]?.url), /^file:\/\/\/execution\/b\//)
        assert.match(String(parts[0]?.text), /Attached files/)
        assert.equal(String(parts[0]?.text).includes('image bytes stay out of prompt'), false)
        assert.equal(String(body.system).includes('Attached files'), false)
        f.backend.audit.push('native_ack')
      })
      const iterator = f.start(async () => { f.backend.audit.push('durable_ack') })
      await iterator.next()
      assert.deepEqual(f.backend.audit.filter((event) => ['native_ack', 'durable_ack', 'issue', 'connect'].includes(event)),
        ['native_ack', 'durable_ack', 'issue', 'connect'])
      f.server.complete(f.correlationId); await drain(iterator)
      assert.equal(f.backend.revocations, 1); assert.equal(f.unmounts, 1)
      assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })

  it('dispatches the existing file-only facade into FIL-05 and adopts the published revision', async () => {
    const f = await fixture()
    try {
      const iterator = f.start(); await iterator.next()
      await publish(f)
      assert.equal(f.backend.messages.get('message-a')?.length, 1)
      assert.equal(f.backend.adopted[0]?.nativeSessionId, f.session.nativeSessionId)
      assert.equal(f.backend.adopted[0]?.turnId, nativeMessageId(f.correlationId))
      assert.equal(f.backend.adopted[0]?.messageId, 'message-a')
      f.server.complete(f.correlationId); await drain(iterator)
      assert.equal(f.backend.messages.get('message-a')?.length, 1)
    } finally { await f.close() }
  })

  it('keeps read-mode policy and FIL-05 mutation denials unchanged', async () => {
    const f = await fixture('read')
    try {
      const iterator = f.start(); await iterator.next()
      await assert.rejects(publish(f), hasFileCode('FILE_TOOL_DENIED'))
      assert.equal(f.backend.copiesMade, 0)
      assert.equal([...f.backend.hostFiles.values()].every((entry) => !entry.writable), true)
      assert.equal(f.server.calls.some((call) => call.path.startsWith('/config') && call.method !== 'GET'), false)
      f.server.complete(f.correlationId); await drain(iterator)
    } finally { await f.close() }
  })

  it.todo('read-mode working-copy edit + publish through a scoped artifact-edit capability (FIL-05 has no such capability at this base)')

  it('observer detach/resume does not reprepare inputs, reissue tools, or inject startup text again', async () => {
    const f = await fixture()
    try {
      const first = f.start(); await first.next()
      const reads = f.backend.reads, materializations = f.backend.materializations
      await first.return?.()
      assert.equal(f.backend.revocations, 0); assert.equal(f.backend.hostFiles.size, 1)
      const second = f.observe(); await second.next()
      assert.equal(f.prompts.length, 1); assert.equal(f.backend.issued.length, 1)
      assert.equal(f.backend.reads, reads); assert.equal(f.backend.materializations, materializations)
      assert.equal(f.resolutions, 1)
      f.server.complete(f.correlationId); await drain(second)
    } finally { await f.close() }
  })

  it('lost native ack recovers only the exact persisted message, then activates tools without another prompt', async () => {
    const f = await fixture()
    try {
      f.onPrompt(() => { throw new OpenCodeNativeDeliveryError('FIXTURE_ACK_LOST', 'fixture lost native ack', 'uncertain') })
      await assert.rejects(f.start().next(), /lost native ack/)
      assert.equal(f.backend.issued.length, 0); assert.equal(f.backend.hostFiles.size, 1)
      const observer = f.observe(); await observer.next()
      assert.equal(f.backend.issued.length, 1); assert.equal(f.prompts.length, 1)
      f.server.complete(f.correlationId); await drain(observer)
    } finally { await f.close() }
  })

  it('a post-ack callback failure cannot downgrade accepted delivery to a definite rejection', async () => {
    const f = await fixture()
    try {
      await assert.rejects(f.start(async () => {
        throw new OpenCodeNativeDeliveryError('FIXTURE_CALLBACK_FAILED', 'fixture durable ack failed', 'definite')
      }).next(), /durable ack failed/)
      assert.equal(f.backend.issued.length, 0); assert.equal(f.backend.hostFiles.size, 1)
      const observer = f.observe(); await observer.next()
      assert.equal(f.prompts.length, 1); assert.equal(f.backend.issued.length, 1)
      f.server.complete(f.correlationId); await drain(observer)
    } finally { await f.close() }
  })

  it('foreign-turn admission is rejected before reading files, issuing credentials or submitting native input', async () => {
    const f = await fixture()
    try {
      f.foreignTurn()
      await assert.rejects(f.start().next(), hasFileCode('FILE_CONTEXT_DENIED'))
      assert.equal(f.backend.reads, 0); assert.equal(f.backend.issued.length, 0)
      assert.equal(f.prompts.length, 0); assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })

  it('the registered facade rejects a different turn token before any FIL-05 read', async () => {
    const f = await fixture()
    try {
      const iterator = f.start(); await iterator.next()
      const reads = f.backend.reads
      await assert.rejects(async () => f.facade.read(`gql_file_${'X'.repeat(43)}`, f.attachment), hasFileCode('FILE_SESSION_INVALID'))
      assert.equal(f.backend.reads, reads)
      f.server.complete(f.correlationId); await drain(iterator)
    } finally { await f.close() }
  })

  it('cancel revokes tools before native abort and removes only the owned input files', async () => {
    const f = await fixture()
    try {
      const iterator = f.start(); await iterator.next()
      assert.equal(await f.manager.cancel(f.session, undefined, nativeMessageId(f.correlationId)), true)
      assert(f.backend.audit.indexOf('revoke') < f.backend.audit.indexOf('abort'))
      assert.equal(f.backend.revocations, 1); assert.equal(f.backend.hostFiles.size, 0)
      assert.equal(f.unmounts, 1)
      await iterator.return?.()
    } finally { await f.close() }
  })

  it('unsupported question with incomplete child abort retains file cleanup and the next-prompt fence', async () => {
    const f = await fixture()
    try {
      const iterator = f.start(); await iterator.next()
      f.server.addSession('ses_file_child', f.session.nativeSessionId)
      f.server.statuses.set('ses_file_child', { type: 'busy' })
      f.server.questions = [{ id: 'que_file', sessionID: 'ses_file_child' }]
      const before = f.server.beforeRequest
      f.server.beforeRequest = (path, init) => path.startsWith('/session/ses_file_child/abort') ? json(false) : before?.(path, init)
      assert.equal((await f.manager.reconcile(f.session, f.correlationId)).terminalResult, undefined)
      assert.equal(f.backend.revocations, 1)
      assert(f.backend.hostFiles.size > 0)
      assert.equal(f.unmounts, 0)
      await iterator.return?.()
      await assert.rejects(f.manager.startTurn(f.session, { prompt: 'next', clientCorrelationId: 'next-file-turn' })[Symbol.asyncIterator]().next(), errorCode('OPENCODE_SESSION_BUSY'))
      assert.equal(f.prompts.length, 1)
      f.server.statuses.delete('ses_file_child')
      assert.equal((await f.manager.reconcile(f.session, f.correlationId)).terminalResult?.error?.code, 'OPENCODE_QUESTION_UNSUPPORTED')
      assert.equal(f.backend.hostFiles.size, 0)
      assert.equal(f.unmounts, 1)
      await iterator.return?.()
    } finally { await f.close() }
  })

  it('foreign-turn cancel leaves this turn and its file credential untouched', async () => {
    const f = await fixture()
    try {
      const iterator = f.start(); await iterator.next()
      assert.equal(await f.manager.cancel(f.session, undefined, nativeMessageId('foreign')), false)
      assert.equal(f.backend.revocations, 0)
      assert.equal(f.backend.audit.includes('abort'), false)
      await f.facade.read(f.backend.token, { ...f.attachment, offset: 0, length: 1 })
      f.server.complete(f.correlationId); await drain(iterator)
    } finally { await f.close() }
  })

  it('definite native rejection cleans prepared inputs without issuing any file session', async () => {
    const f = await fixture()
    try {
      f.rejectPrompt()
      await assert.rejects(f.start().next())
      assert.equal(f.backend.issued.length, 0); assert.equal(f.backend.hostFiles.size, 0)
      assert.equal(f.unmounts, 1)
    } finally { await f.close() }
  })

  it('native process replacement revokes old tools and does not replay the attachment prompt', async () => {
    const f = await fixture()
    try {
      const iterator = f.start(); await iterator.next(); await iterator.return?.()
      f.server.crashed = true
      const observer = f.observe(); await drain(observer)
      assert.equal(f.prompts.length, 1); assert.equal(f.backend.issued.length, 1)
      assert.equal(f.backend.revocations, 1); assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })

  it('post-ack tool registration failure is fenced rather than resubmitting native input', async () => {
    const f = await fixture()
    try {
      f.failConnect()
      await assert.rejects(f.start().next(), hasFileCode('FILE_NATIVE_SETUP_FAILED'))
      assert.equal(f.backend.revocations, 1); assert.equal(f.backend.hostFiles.size, 1)
      const resumed = f.start(); await resumed.next()
      assert.equal(f.prompts.length, 1); assert.equal(f.backend.issued.length, 1)
      await resumed.return?.()
    } finally { await f.close() }
  })

  it('failed native shutdown still revokes file authority and keeps cleanup retryable', async () => {
    const f = await fixture()
    const dispose = f.server.dispose.bind(f.server)
    try {
      const iterator = f.start(); await iterator.next()
      const facade = f.facade, token = f.backend.token
      f.server.dispose = async () => { throw new Error('fixture stop unavailable') }
      await assert.rejects(f.manager.dispose(), AggregateError)
      assert.equal(f.backend.revocations, 1)
      await assert.rejects(async () => facade.read(token, f.attachment), hasFileCode('FILE_SESSION_INVALID'))
      assert.equal(f.backend.hostFiles.size, 1)
    } finally { f.server.dispose = dispose; await f.close() }
  })

  it('text-only turns preserve the existing prompt and do not mount any file tools', async () => {
    const f = await fixture()
    try {
      f.withoutAttachments()
      const iterator = f.start(); await iterator.next()
      assert.deepEqual(f.prompts[0]?.body?.parts, [{ type: 'text', text: 'hello' }])
      assert.equal(f.backend.issued.length, 0); assert.equal(f.backend.materializations, 0)
      f.server.complete(f.correlationId); await drain(iterator)
    } finally { await f.close() }
  })
})
