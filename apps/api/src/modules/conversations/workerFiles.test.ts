import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { MainWorkerConversationBridge, type WorkerConversationChannel } from './workerBridge.js'
import type { PrepareWorkerFiles } from './mainWorkerFiles.js'
import { WorkerConversationFiles } from './workerFiles.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { localCodexChatHost } from '../harnesses/codexFiles/localHost.js'
import { prepareCodexFileTurn } from '../harnesses/codexFiles/index.js'
import { filePorts, fileScope, sourceRef, publishedRef } from '../../../test/fixtures/codex-file-runtime-helpers.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'

async function fixture(options: { repeatCopies?: boolean } = {}) {
  const repeatCopies = options.repeatCopies
  const directory = await privateFixtureDirectory('worker-attachments-')
  const f = workerConversationFixture('agent')
  f.binding.owner.conversationId = fileScope.chat.conversationId
  const bridge = new MainWorkerConversationBridge()
  const ports = filePorts()
  const current = vi.fn(async () => {})
  const physical = vi.fn(async () => {})
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
    capture: () => ({ binding: f.connection, request: async (payload, options) => ({
      payload: await bridge.handle(payload, f.connection, options?.signal ?? AbortSignal.timeout(1000)),
    }) }) })
  const worker = new WorkerConversationFiles(callbacks)
  const sentCopies: unknown[] = []
  let source: WorkerConversationRpcRequest | undefined
  const channel: WorkerConversationChannel = { binding: f.connection, request: async (payload, options) => {
      const request = payload as WorkerConversationRpcRequest
      if (request.method === 'conversation.file-copy') {
        sentCopies.push(request.copy)
        const signal = options?.signal ?? AbortSignal.timeout(1000)
        const result = await worker.copy(request, signal)
        if (repeatCopies && ['begin', 'chunk', 'finish'].includes(request.copy.phase)) {
          expect(await worker.copy(request, signal)).toEqual(result)
        }
        return { payload: result }
      }
      source = request
      return { payload: {} }
    } }
  const prepareFiles: PrepareWorkerFiles = async ({ host, assertHost, ...turn }) => {
      await assertHost()
      return prepareCodexFileTurn({ ownerPrincipalId: 'owner-a', scope: fileScope,
        nativeSessionId: turn.session.nativeSessionId, messageId: 'message-a', admissionId: 'message',
        executionHostId: host.executionHostId, projectMode: 'write', allowMutation: true,
        allowedTools: ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result'],
        expiresAt: new Date('2026-09-28T01:00:00Z'), attachments: [sourceRef],
      }, { ...ports.dependencies, host, files: ports.files, editsOnly: true }, turn.signal)
    }
  const lease = bridge.capture({
    request: { method: 'conversation.start-turn', binding: f.binding, session: f.session,
      prompt: 'Read the attached notes.', correlationId: 'message' }, current, channel,
    callbacks: { submitted: async () => {}, files: prepareFiles },
  })
  await lease.request()
  const adapter = worker.adapter({ source: () => {
    if (!source) throw new Error('Missing original request')
    return source
  }, host: () => localCodexChatHost(join(directory, 'storage')),
  assertCurrent: physical, signal: AbortSignal.timeout(10000) })
  const invoke = (payload: Record<string, unknown>, connection = f.connection) => bridge.handle({ ...payload,
    binding: f.binding, admissionId: lease.admissionId }, connection, AbortSignal.timeout(1000))
  const prepare = () => adapter.prepare({ session: f.session, clientCorrelationId: 'message',
    signal: AbortSignal.timeout(5000) })
  const submitted = () => invoke({ method: 'conversation.submitted', correlationId: 'message',
    identity: { nativeTurnId: 'native-turn' } })
  return { ...f, ports, directory, lease, invoke, prepare, submitted, sentCopies, current, physical,
    bridge, worker, channel, prepareFiles,
    async close() { await lease.close(); await worker.close(); await rm(directory, { recursive: true, force: true }) } }
}

it('delivers immutable worker copies and uses the persisted native ACK for file tools', async () => {
  const f = await fixture()
  try {
    const turn = await f.prepare()
    expect(turn).toBeDefined()
    const input = await turn!.nativeInput('Read the attached notes.')
    const text = input[0]
    if (text?.type !== 'text') throw new Error('Expected native text input')
    const attachment = text.text.split('\n').find(line => line.startsWith('{"filename"'))!
    const path = (JSON.parse(attachment) as { path: string }).path
    expect(await readFile(path, 'utf8')).toBe('# Attached document\n')
    expect(text.text).not.toContain('gql_file_')
    await expect(turn!.activate('native-turn')).rejects.toMatchObject({ status: 409 })
    expect(f.ports.tokens.size).toBe(0)
    await f.submitted()
    await turn!.activate('native-turn')
    expect(f.ports.tokens.size).toBe(1)
    expect(await turn!.call({ threadId: f.session.nativeSessionId, turnId: 'native-turn',
      tool: 'files_list', arguments: { scope: fileScope } })).toMatchObject({ success: true })
    await expect(turn!.call({ threadId: 'foreign', turnId: 'native-turn',
      tool: 'files_list', arguments: { scope: fileScope } })).rejects.toMatchObject({ status: 409 })
    const invalid = await turn!.call({ threadId: f.session.nativeSessionId, turnId: 'native-turn',
      tool: 'files_create_working_copy', arguments: { commandId: 'short', source: sourceRef, destination: fileScope } })
    expect(invalid.success).toBe(false)
    expect(f.ports.events).not.toContain('createWorkingCopy')
    const copy = await turn!.call({ threadId: f.session.nativeSessionId, turnId: 'native-turn',
      tool: 'files_create_working_copy', arguments: { commandId: 'copy-command-1', source: sourceRef, destination: fileScope } })
    expect(copy.success).toBe(true)
    const publish = await turn!.call({ threadId: f.session.nativeSessionId, turnId: 'native-turn',
      tool: 'files_publish_result', arguments: { commandId: 'publish-1', artifactId: 'artifact-a',
        scope: fileScope, filename: 'result.md', mediaType: 'text/markdown' } })
    expect(publish.success).toBe(true)
    expect(await turn!.publications()).toEqual([publishedRef])
    await turn!.close()
    expect(f.ports.tokens.size).toBe(0)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.physical).toHaveBeenCalled()
  } finally { await f.close() }
})

it('denies foreign sessions, correlations, replacement prompts and revoked original senders', async () => {
  const f = await fixture()
  try {
    const callback = { method: 'conversation.files', session: f.session, correlationId: 'message',
      action: { phase: 'prepare', executionHostId: 'unallocated' } }
    await expect(f.invoke({ ...callback, session: { ...f.session, nativeSessionId: 'foreign' } }))
      .rejects.toMatchObject({ status: 403 })
    await expect(f.invoke({ ...callback, correlationId: 'replacement' })).rejects.toMatchObject({ status: 403 })
    const turn = await f.prepare()
    await expect(turn!.nativeInput('A replacement task')).rejects.toMatchObject({ status: 403 })
    f.current.mockRejectedValueOnce(new Error('Sender revoked'))
    await expect(turn!.nativeInput('Read the attached notes.')).rejects.toThrow('Sender revoked')
    expect(f.ports.tokens.size).toBe(0)
    await turn!.close()
  } finally { await f.close() }
})

it('rejects unsolicited host copies and a replay through an ended or different channel', async () => {
  const f = await fixture()
  try {
    await f.prepare()
    await expect(f.invoke({ method: 'conversation.file-copy-authorize', copy: {
      phase: 'begin', executionHostId: 'unallocated', transferId: randomUUID(), filename: 'other.md',
      mediaType: 'text/markdown', byteSize: 0, sha256: '0'.repeat(64),
    } })).rejects.toMatchObject({ status: 403 })
    const callback = { method: 'conversation.files', session: f.session, correlationId: 'message',
      action: { phase: 'publications' } }
    await expect(f.invoke(callback, { ...f.connection, connectionGeneration: f.connection.connectionGeneration + 1 }))
      .rejects.toMatchObject({ status: 403 })
    await f.lease.close()
    await expect(f.invoke(callback)).rejects.toMatchObject({ status: 403 })
  } finally { await f.close() }
})

it('acknowledges repeated transfer frames without duplicating bytes or replacing the registered copy', async () => {
  const f = await fixture({ repeatCopies: true })
  try {
    const turn = await f.prepare()
    const input = await turn!.nativeInput('Read the attached notes.')
    const text = input[0]
    if (text?.type !== 'text') throw new Error('Expected native text input')
    const attachment = text.text.split('\n').find(line => line.startsWith('{"filename"'))!
    const path = (JSON.parse(attachment) as { path: string }).path
    expect(await readFile(path, 'utf8')).toBe('# Attached document\n')
    expect(f.sentCopies).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'begin' }), expect.objectContaining({ phase: 'chunk', offset: 0 }),
      expect.objectContaining({ phase: 'finish' }),
    ]))
    await turn!.close()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
})

it('rejects file authority on read-only leases and on management-MCP sessions', async () => {
  for (const requestKind of ['read', 'scoped'] as const) {
    const f = workerConversationFixture('operator')
    const bridge = new MainWorkerConversationBridge()
    const prepare = vi.fn(async () => undefined)
    const binding = requestKind === 'scoped' ? { ...f.binding, appMcpAccess: 'scoped' as const } : f.binding
    const request: WorkerConversationRpcRequest = requestKind === 'read'
      ? { method: 'conversation.history', session: f.session, binding }
      : { method: 'conversation.start-turn', session: f.session, binding, prompt: 'Read', correlationId: 'message' }
    const lease = bridge.capture({ request, current: async () => {}, callbacks: { files: prepare },
      channel: { binding: f.connection, request: async () => ({ payload: {} }) } })
    try {
      await expect(bridge.handle({ method: 'conversation.files', binding, admissionId: lease.admissionId,
        session: f.session, correlationId: 'message', action: { phase: 'prepare', executionHostId: 'host' } },
      f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
      expect(prepare).not.toHaveBeenCalled()
    } finally { await lease.close() }
  }
})

it('restores file callbacks for the recorded turn while retaining its original worker input copies', async () => {
  const f = await fixture()
  let recovery: ReturnType<MainWorkerConversationBridge['capture']> | undefined
  try {
    const turn = await f.prepare()
    const input = await turn!.nativeInput('Read the attached notes.')
    const text = input[0]
    if (text?.type !== 'text') throw new Error('Expected native text input')
    const attachment = text.text.split('\n').find(line => line.startsWith('{"filename"'))!
    const path = (JSON.parse(attachment) as { path: string }).path
    await f.submitted()
    await turn!.activate('native-turn')
    await f.lease.close()
    const request: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }> = {
      method: 'conversation.reconcile', binding: f.binding, session: f.session, correlationId: 'message',
    }
    recovery = f.bridge.capture({ request, recoveredTurnId: 'native-turn', current: f.current,
      channel: f.channel, callbacks: { files: f.prepareFiles } })
    const recovered = { ...request, admissionId: recovery.admissionId }
    await expect(f.worker.recover(recovered, 'another-turn', AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ status: 409 })
    await f.worker.recover(recovered, 'native-turn', AbortSignal.timeout(1000))
    expect(await readFile(path, 'utf8')).toBe('# Attached document\n')
    expect(f.ports.issued).toHaveLength(2)
    expect(f.ports.issued[1]).toMatchObject({ nativeSessionId: f.session.nativeSessionId,
      turnId: 'native-turn', messageId: 'message-a' })
    await f.worker.recover(recovered, 'native-turn', AbortSignal.timeout(1000))
    expect(f.ports.issued).toHaveLength(2)
    expect(await turn!.call({ threadId: f.session.nativeSessionId, turnId: 'native-turn',
      tool: 'files_list', arguments: { scope: fileScope } })).toMatchObject({ success: true })
    await expect(turn!.nativeInput('Read the attached notes.')).rejects.toMatchObject({ status: 403 })
    await turn!.close()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await recovery?.close(); await f.close() }
})
