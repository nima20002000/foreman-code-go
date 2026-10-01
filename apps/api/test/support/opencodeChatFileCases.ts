import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { OpenCodeFileTurn } from '../../src/modules/harnesses/opencodeFiles/turn.js'
import type { AcceptedOpenCodeFileTurn, OpenCodeFilePart } from '../../src/modules/harnesses/opencodeFiles/types.js'
import { createChatFileBackend, fileContext, fileScope, fileSignal, hasFileCode } from './opencodeChatFileFixture.js'

async function fixture(mode: 'read' | 'write' = 'write') {
  const backend = createChatFileBackend()
  const requests: { path: string; body?: Record<string, unknown> }[] = []
  const statuses: Record<string, unknown> = { graphql: { status: 'disabled' } }
  let generation = 1, failConnect = false
  const http = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const body = text ? JSON.parse(text) : undefined
    requests.push({ path, ...(body ? { body } : {}) })
    response.setHeader('content-type', 'application/json')
    if (path === '/config') return response.end(JSON.stringify({ mcp: { graphql: { enabled: false } } }))
    if (path === '/mcp' && request.method === 'POST') {
      backend.audit.push('connect')
      if (failConnect) { response.statusCode = 503; return response.end(JSON.stringify(body)) }
      statuses[body.name] = { status: 'connected' }; return response.end(JSON.stringify(statuses))
    }
    if (path === '/mcp') return response.end(JSON.stringify(statuses))
    if (path.endsWith('/disconnect')) { backend.audit.push('disconnect'); return response.end('true') }
    response.statusCode = 404; response.end('{}')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  assert(address && typeof address !== 'string')
  const server = {
    expectedVersion: '1.18.31', get generation() { return generation },
    async ensure() {}, async dispose() {},
    async request(path: string, init?: RequestInit, signal?: AbortSignal, expected?: number) {
      if (expected !== undefined && expected !== generation) throw new Error('fixture generation changed')
      return fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, signal: signal ?? null })
    },
  }
  const admission: AcceptedOpenCodeFileTurn = { context: fileContext({ allowMutation: mode === 'write' }),
    attachments: [backend.add()], mode, executionHostId: 'execution-b', directory: '/workspace/project',
    expiresAt: new Date(Date.now() + 60_000) }
  const options = { service: backend.service, host: backend.host, server, endpoint: 'http://127.0.0.1:9876/mcp/files',
    appMcpServerName: 'graphql', maxFileBytes: 25 * 1024 * 1024, maxAttachments: 10,
    adoptPublished: backend.adoptPublished }
  const turn = new OpenCodeFileTurn(options)
  const prepare = () => turn.prepareInputs(admission, backend.readAccepted(admission.context), fileSignal())
  const acknowledge = async () => { turn.submissionAttempted(); backend.audit.push('native_ack'); await turn.acknowledge(fileSignal()) }
  return { backend, server, options, turn, admission, requests, prepare, acknowledge,
    failConnect() { failConnect = true }, restart() { generation++ },
    async close() {
      backend.failRevoke(false); backend.failAdopt(false); backend.failRemove(false)
      try { await turn.nativeProcessClosed(fileSignal()) } finally {
        http.closeAllConnections()
        await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
      }
    },
  }
}
const publishInput = (id: string) => ({ commandId: randomUUID(), artifactId: id,
  filename: 'result.md', mediaType: 'text/markdown' as const, scope: structuredClone(fileScope) })
async function copy(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.turn.createWorkingCopy(f.backend.token, { commandId: randomUUID(),
    source: f.admission.attachments[0]!, destination: f.admission.context.scope }, fileSignal())
  return result.value.artifactId
}

/** Run unchanged under Vitest and the TypeScript-only standalone smoke runner. */
export function registerOpenCodeChatFileCases(test: (name: string, body: () => Promise<void>) => unknown): void {
  test('prepares bounded native image parts without a credential or MCP registration', async () => {
    const f = await fixture()
    try {
      f.admission.attachments = [f.backend.add('not embedded in prompt', 'image/png', 'a #.png')]
      const prepared = await f.prepare()
      assert.equal(f.backend.issued.length, 0)
      assert.equal(f.requests.some((request) => request.path === '/mcp' && request.body), false)
      assert.equal(f.backend.copiesMade, 0)
      assert.equal(f.backend.reads, 2)
      assert.equal([...f.backend.hostFiles.values()].every((entry) => !entry.writable), true)
      const part: OpenCodeFilePart | undefined = prepared.imageParts[0]
      assert.equal(part?.type, 'file'); assert.equal(part?.mime, 'image/png')
      assert.match(part?.url ?? '', /^file:\/\/\/execution\/b\/.+\/a%20%23.png$/)
      assert.equal(prepared.promptSuffix.includes('not embedded in prompt'), false)
      assert.equal(prepared.promptSuffix.includes('gql_file_'), false)
      assert.match(prepared.identity, /^[a-f0-9]{64}$/)
    } finally { await f.close() }
  })
  test('requires attempted submission, then issues and registers exactly once after ack', async () => {
    const f = await fixture()
    try {
      await f.prepare()
      await assert.rejects(f.turn.acknowledge(fileSignal()), hasFileCode('FILE_SUBMISSION_INVALID'))
      await f.acknowledge()
      await f.turn.acknowledge(fileSignal())
      assert.equal(f.backend.issued.length, 1)
      assert.deepEqual(f.backend.audit.filter((event) => ['native_ack', 'issue', 'connect'].includes(event)), ['native_ack', 'issue', 'connect'])
      assert.deepEqual(f.backend.issued[0]!.context, f.admission.context)
      assert.match(f.backend.token, /^gql_file_[A-Za-z0-9_-]{43}$/)
      assert.throws(() => f.turn.submissionAttempted(), hasFileCode('FILE_SUBMISSION_FENCED'))
    } finally { await f.close() }
  })
  test('same-turn preparation reuses inputs and rejects changed pinned input', async () => {
    const f = await fixture()
    try {
      const prepared = await f.prepare(), reads = f.backend.reads, count = f.backend.materializations
      assert.deepEqual(await f.prepare(), prepared)
      assert.equal(f.backend.reads, reads); assert.equal(f.backend.materializations, count)
      f.admission.attachments = [f.backend.add('different')]
      await assert.rejects(f.prepare(), hasFileCode('FILE_TURN_CONFLICT'))
      assert.equal(f.backend.issued.length, 0)
    } finally { await f.close() }
  })
  test('working-copy edit and publish adopt only into the originating message', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const id = await copy(f)
      f.backend.hostFiles.get(id)!.bytes = Buffer.from('# changed\n')
      await f.turn.publish(f.backend.token, publishInput(id), fileSignal())
      assert.equal(f.backend.messages.get('message-a')?.length, 1)
      assert.equal(f.backend.messages.has('message-other'), false)
      assert.deepEqual(f.backend.adopted[0], f.admission.context)
      const source = f.backend.values.get(`${f.admission.attachments[0]!.fileId}/${f.admission.attachments[0]!.revisionId}`)!
      assert.equal(source.bytes.toString(), '# input\n')
    } finally { await f.close() }
  })
  test('terminal adoption recovers a second publish with a lost acknowledgement', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const id = await copy(f)
      await f.turn.publish(f.backend.token, publishInput(id), fileSignal())
      f.backend.hostFiles.get(id)!.bytes = Buffer.from('# second\n')
      f.backend.losePublishAck()
      await assert.rejects(f.turn.publish(f.backend.token, publishInput(id), fileSignal()), /lost publish ack/)
      await f.turn.finish('terminal', fileSignal())
      assert.equal(f.backend.messages.get('message-a')?.length, 2)
      assert.equal(f.backend.revocations, 1)
      assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })
  for (const closure of ['terminal', 'process'] as const) {
    test(`${closure} cleanup retry adopts a finalized publication after lost ACK and revocation`, async () => {
      const f = await fixture()
      try {
        await f.prepare(); await f.acknowledge()
        const id = await copy(f)
        f.backend.losePublishAck()
        await assert.rejects(f.turn.publish(f.backend.token, publishInput(id), fileSignal()), /lost publish ack/)
        f.backend.failAdopt(true)
        await assert.rejects(closure === 'terminal'
          ? f.turn.finish('terminal', fileSignal()) : f.turn.nativeProcessClosed(fileSignal()), /retry/)
        assert.equal(f.backend.revocations, 1)
        assert.equal(f.backend.hostFiles.size, 0)
        assert.equal(f.backend.messages.get('message-a')?.length ?? 0, 0)
        f.backend.failAdopt(false)
        await f.turn.retryCleanup(fileSignal())
        await f.turn.retryCleanup(fileSignal())
        assert.equal(f.backend.messages.get('message-a')?.length, 1)
        assert.equal(f.backend.messages.has('message-other'), false)
        assert.equal(f.backend.issued.length, 1)
        assert.equal(f.backend.revocations, 1)
      } finally { await f.close() }
    })
  }
  test('cleanup failure does not block ledger adoption after terminal authority revocation', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const id = await copy(f)
      f.backend.losePublishAck()
      await assert.rejects(f.turn.publish(f.backend.token, publishInput(id), fileSignal()), /lost publish ack/)
      f.backend.failRemove(true); f.backend.failAdopt(true)
      await assert.rejects(f.turn.finish('terminal', fileSignal()), AggregateError)
      assert.equal(f.backend.revocations, 1)
      f.backend.failAdopt(false)
      await assert.rejects(f.turn.retryCleanup(fileSignal()), AggregateError)
      assert.equal(f.backend.messages.get('message-a')?.length, 1)
      assert(f.backend.hostFiles.size > 0)
      assert.throws(() => f.turn.assertCredential(f.backend.token), hasFileCode('FILE_TURN_CLOSED'))
      f.backend.failRemove(false)
      await f.turn.retryCleanup(fileSignal())
      assert.equal(f.backend.messages.get('message-a')?.length, 1)
      assert.equal(f.backend.hostFiles.size, 0)
      assert.equal(f.backend.issued.length, 1)
    } finally { await f.close() }
  })
  test('read mode preserves mutation denials without granting writable input paths', async () => {
    const f = await fixture('read')
    try {
      await f.prepare(); await f.acknowledge()
      await assert.rejects(copy(f), hasFileCode('FILE_TOOL_DENIED'))
      await assert.rejects(f.turn.publish(f.backend.token, publishInput('foreign-artifact'), fileSignal()), hasFileCode('FILE_TOOL_DENIED'))
      assert.equal(f.backend.copiesMade, 0)
      assert.equal([...f.backend.hostFiles.values()].every((entry) => !entry.writable), true)
      assert.equal(f.requests.some((request) => request.path === '/config' && request.body), false)
    } finally { await f.close() }
  })
  test('a foreign credential, source destination, or artifact cannot mutate this turn', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const foreign = await f.backend.service.sessions.issueForAcceptedSession(fileContext({ turnId: 'foreign' }), new Date(Date.now() + 60_000))
      assert.throws(() => f.turn.assertCredential(foreign), hasFileCode('FILE_CONTEXT_DENIED'))
      const own = f.backend.issued[0]!.token
      await assert.rejects(f.turn.createWorkingCopy(own, { commandId: randomUUID(), source: f.admission.attachments[0]!,
        destination: { ...fileScope, chat: { ...fileScope.chat, conversationId: 'foreign' } } }, fileSignal()), hasFileCode('FILE_CONTEXT_DENIED'))
      await assert.rejects(f.turn.publish(own, publishInput('foreign-artifact'), fileSignal()), hasFileCode('FILE_ARTIFACT_NOT_FOUND'))
      assert.equal(f.backend.copiesMade, 0)
    } finally { await f.close() }
  })
  test('uncertain delivery retains inputs, but definite rejection removes them without issuing a token', async () => {
    const f = await fixture()
    try {
      await f.prepare(); f.turn.submissionAttempted()
      await assert.rejects(f.turn.retryCleanup(fileSignal()), hasFileCode('FILE_SUBMISSION_FENCED'))
      assert.equal(f.backend.hostFiles.size, 1)
      assert.equal(f.backend.issued.length, 0)
      await f.turn.finish('definite_rejection', fileSignal())
      assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })
  test('cancel revokes authority before releasing native input files', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const token = f.backend.token
      await f.turn.revoke()
      assert.equal(f.backend.hostFiles.size, 1)
      assert.throws(() => f.turn.assertCredential(token), hasFileCode('FILE_TURN_CLOSED'))
      await f.turn.finish('terminal', fileSignal())
      assert.equal(f.backend.hostFiles.size, 0)
      assert.equal(f.backend.revocations, 1)
      assert(f.backend.audit.indexOf('revoke') < f.backend.audit.indexOf('remove'))
    } finally { await f.close() }
  })
  test('process replacement rejects old tools and cleanup never restarts the native server', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const token = f.backend.token
      f.restart()
      assert.throws(() => f.turn.assertCredential(token), hasFileCode('FILE_NATIVE_PROCESS_CHANGED'))
      const requests = f.requests.length
      await f.turn.nativeProcessClosed(fileSignal())
      assert.equal(f.requests.length, requests)
      assert.equal(f.backend.revocations, 1)
      assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })
  test('registration failure revokes its token without deleting an accepted turn input', async () => {
    const f = await fixture()
    try {
      await f.prepare(); f.failConnect(); f.turn.submissionAttempted()
      await assert.rejects(f.turn.acknowledge(fileSignal()), (error: unknown) => {
        assert.equal(String(error).includes(f.backend.token), false)
        return hasFileCode('FILE_NATIVE_SETUP_FAILED')(error)
      })
      assert.equal(f.backend.revocations, 1)
      assert.equal(f.backend.hostFiles.size, 1)
      await assert.rejects(f.turn.acknowledge(fileSignal()), hasFileCode('FILE_SUBMISSION_INVALID'))
      assert.equal(f.backend.issued.length, 1)
    } finally { await f.close() }
  })
  test('adoption failure still revokes and cleans; retry adopts without the revoked token', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const id = await copy(f)
      f.backend.failAdopt(true)
      await assert.rejects(f.turn.publish(f.backend.token, publishInput(id), fileSignal()), /adoption unavailable/)
      await assert.rejects(f.turn.finish('terminal', fileSignal()), AggregateError)
      assert.equal(f.backend.revocations, 1); assert.equal(f.backend.hostFiles.size, 0)
      f.backend.failAdopt(false)
      await f.turn.finish('terminal', fileSignal())
      assert.equal(f.backend.messages.get('message-a')?.length, 1)
    } finally { await f.close() }
  })
  test('revoke failure keeps the process fenced and cleanup retry never issues another token', async () => {
    const f = await fixture()
    try {
      await f.prepare(); await f.acknowledge()
      const token = f.backend.token
      f.backend.failRevoke(true)
      await assert.rejects(f.turn.finish('terminal', fileSignal()), AggregateError)
      assert.throws(() => f.turn.assertCredential(token), hasFileCode('FILE_TURN_CLOSED'))
      const other = new OpenCodeFileTurn(f.options)
      await assert.rejects(other.prepareInputs({ ...f.admission, context: fileContext({ turnId: 'another' }) },
        f.backend.readAccepted(f.admission.context), fileSignal()), hasFileCode('FILE_NATIVE_PROCESS_BUSY'))
      f.backend.failRevoke(false)
      await f.turn.retryCleanup(fileSignal())
      assert.equal(f.backend.issued.length, 1); assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })
  test('owner revocation fails before native submission or token issue', async () => {
    const f = await fixture()
    try {
      f.backend.revokeOwner()
      await assert.rejects(f.prepare(), hasFileCode('FILE_TURN_SETUP_FAILED'))
      assert.equal(f.backend.issued.length, 0)
      assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })
  test('expired pinned attachment fails closed before token issuance', async () => {
    const f = await fixture()
    try {
      const ref = f.admission.attachments[0]!
      f.backend.values.get(`${ref.fileId}/${ref.revisionId}`)!.expired = true
      await assert.rejects(f.prepare(), hasFileCode('FILE_ATTACHMENT_UNAVAILABLE'))
      assert.equal(f.backend.issued.length, 0); assert.equal(f.backend.hostFiles.size, 0)
    } finally { await f.close() }
  })
  test('legacy standalone bridge remains compatible while the manager uses the post-ack entry', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, fileSignal())
      assert.equal(f.backend.issued.length, 1)
      assert.equal(f.backend.copiesMade, 1)
      f.turn.submissionAttempted(); f.turn.submissionAcknowledged()
      await f.turn.finish('terminal', fileSignal())
      assert.equal(f.backend.revocations, 1)
    } finally { await f.close() }
  })
}
