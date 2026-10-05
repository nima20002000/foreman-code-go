import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, symlink, link, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileRevision, MessageAttachmentRef } from '@foreman-code/contracts/files'
import type { FileToolContext } from '../../src/modules/files/tools/types.js'
import { OpenCodeFileTurn } from '../../src/modules/harnesses/opencodeFiles/turn.js'
import { fileDeliveryPrompt, nativeImagePart, sha256 } from '../../src/modules/harnesses/opencodeFiles/attachments.js'
import { LocalOpenCodeExecutionFiles, assertProtectedSourcePaths } from '../../src/modules/harnesses/opencodeFiles/host.js'
import type { AcceptedOpenCodeFileTurn, OpenCodeExecutionFiles, OpenCodeFileService } from '../../src/modules/harnesses/opencodeFiles/types.js'

const limit = 25 * 1024 * 1024
const signal = () => AbortSignal.timeout(10_000)
const tools = ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result'] as const
const scope = { kind: 'temporary' as const, chat: { kind: 'operator' as const,
  ownerPrincipalId: 'owner-a', operatorId: 'operator-a', conversationId: 'conversation-a' } }
const context = (): FileToolContext => ({ ownerPrincipalId: 'owner-a', scope, nativeSessionId: 'session-a',
  turnId: randomUUID(), allowMutation: true, allowedTools: [...tools] })
const denied = (code: string) => Object.assign(new Error(code), { code })
const withCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code

type Stored = { revision: FileRevision; bytes: Buffer; unavailable?: boolean }
function memoryService() {
  const values = new Map<string, Stored>()
  const sessions = new Map<string, FileToolContext>()
  const artifacts = new Map<string, { bytes: Buffer; state: string; writeId: string; source: MessageAttachmentRef }>()
  const receipts = new Map<string, unknown>(), copies = new Map<string, string>()
  const issued: { token: string; context: FileToolContext }[] = []
  const publications: MessageAttachmentRef[] = []
  const reads: { offset: number; length: number }[] = []
  let failRevoke = false, failPublishAck = false, copiesMade = 0, revocations = 0
  let alterRead: ((value: Record<string, unknown>) => void) | undefined
  const pin = (ref: MessageAttachmentRef) => `${ref.fileId}/${ref.revisionId}`
  const authenticate = async (token?: string, tool?: string) => {
    const ctx = token ? sessions.get(token) : undefined
    if (!ctx) throw denied('FILE_SESSION_EXPIRED')
    if (tool && (!ctx.allowedTools.includes(tool as typeof tools[number])
      || ((tool === 'files.publish_result' || tool === 'files.create_working_copy') && !ctx.allowMutation))) throw denied('FILE_TOOL_DENIED')
    return { context: ctx, principal: { id: ctx.ownerPrincipalId }, binding: sha256(JSON.stringify(ctx)) }
  }
  const add = (text = '# original\n', mediaType: FileRevision['mediaType'] = 'text/markdown', filename = 'input.md') => {
    const bytes = Buffer.from(text), ref = { fileId: randomUUID(), revisionId: randomUUID() }
    const revision: FileRevision = { ...ref, filename, mediaType, byteSize: bytes.length,
      sha256: sha256(bytes), origin: 'upload', createdAt: new Date().toISOString() }
    values.set(pin(ref), { bytes, revision })
    return ref
  }
  const api = {
    sessions: {
      authenticate,
      async issueForAcceptedSession(ctx: FileToolContext) {
        const token = `gql_file_${Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43)}`
        sessions.set(token, structuredClone(ctx)); issued.push({ token, context: structuredClone(ctx) }); return token
      },
      async revoke(token: string) { if (failRevoke) throw new Error('database unavailable'); sessions.delete(token); revocations++ },
    },
    artifacts: {
      async get(_caller: unknown, id: string) {
        const entry = artifacts.get(id)
        if (!entry) throw denied('FILE_ARTIFACT_NOT_FOUND')
        return { ...entry, artifactId: id }
      },
      async beginWrite(token: string, id: string) {
        await authenticate(token, 'files.publish_result')
        const entry = artifacts.get(id)
        if (!entry) throw denied('FILE_ARTIFACT_NOT_FOUND')
        if (entry.state === 'writing') throw denied('FILE_ARTIFACT_BUSY')
        entry.state = 'writing'; entry.writeId = randomUUID(); return entry.writeId
      },
      async completeWrite(token: string, id: string, writeId: string, source: AsyncIterable<Uint8Array>) {
        await authenticate(token, 'files.publish_result')
        const entry = artifacts.get(id)!
        if (entry.writeId !== writeId) throw denied('FILE_ARTIFACT_WRITE_STALE')
        const chunks: Uint8Array[] = []; for await (const chunk of source) chunks.push(chunk)
        entry.bytes = Buffer.concat(chunks); entry.state = 'complete'
      },
      async abortWrite(_token: string, id: string) { artifacts.get(id)!.state = 'failed' },
    },
    async list(token: string) { await authenticate(token, 'files.list'); return { items: [], pageInfo: { nextCursor: null } } },
    async read(token: string, input: MessageAttachmentRef & { offset?: number; length?: number }) {
      await authenticate(token, 'files.read')
      const entry = values.get(pin(input))
      if (!entry || entry.unavailable) return { status: 'unavailable', ref: input, reason: 'expired' }
      const offset = input.offset ?? 0, length = input.length ?? 65_536
      reads.push({ offset, length })
      const bytes = entry.bytes.subarray(offset, offset + length)
      const result = { status: 'ready', file: { scope, state: 'ready' }, revision: entry.revision,
        readAt: new Date().toISOString(), offset, byteLength: bytes.length,
        contentBase64: bytes.toString('base64'), eof: offset + bytes.length === entry.bytes.length }
      alterRead?.(result)
      return result
    },
    async createWorkingCopy(token: string, input: { commandId: string; source: MessageAttachmentRef; destination: unknown }) {
      await authenticate(token, 'files.create_working_copy')
      const original = values.get(pin(input.source))!
      let id = copies.get(input.commandId)
      const replayed = !!id
      if (!id) {
        id = randomUUID(); copies.set(input.commandId, id); copiesMade++
        artifacts.set(id, { bytes: Buffer.from(original.bytes), source: input.source, state: 'complete', writeId: randomUUID() })
      }
      return { value: { artifactId: id, source: input.source, destination: input.destination,
        filename: original.revision.filename, createdAt: original.revision.createdAt }, replayed }
    },
    async publish(token: string, input: { commandId: string; artifactId: string; filename: string; mediaType: FileRevision['mediaType'] }) {
      await authenticate(token, 'files.publish_result')
      const entry = artifacts.get(input.artifactId)!
      if (entry.state !== 'complete') throw denied('FILE_ARTIFACT_INCOMPLETE')
      const hash = sha256(JSON.stringify([entry.bytes.toString('base64'), input.artifactId, input.filename, input.mediaType]))
      const old = receipts.get(input.commandId) as { hash: string; result: unknown } | undefined
      if (old && old.hash !== hash) throw denied('FILE_REQUEST_CONFLICT')
      if (old) return { ...(old.result as object), replayed: true }
      const ref = add(entry.bytes.toString(), input.mediaType, input.filename)
      const revision = { ...values.get(pin(ref))!.revision, origin: 'agent_output' }
      const result = { value: { file: { ...ref, scope }, revision }, replayed: false }
      publications.push(ref); receipts.set(input.commandId, { hash, result })
      if (failPublishAck) { failPublishAck = false; throw new Error('lost acknowledgement') }
      return result
    },
    async publishedForTurn(token: string) { await authenticate(token, 'files.list'); return publications },
  }
  return { service: api as unknown as OpenCodeFileService, add, values, artifacts, issued, reads,
    get token() { return issued.at(-1)!.token }, get copiesMade() { return copiesMade }, get revocations() { return revocations },
    failRevoke(value: boolean) { failRevoke = value }, losePublishAck() { failPublishAck = true },
    alterRead(fn: typeof alterRead) { alterRead = fn },
  }
}

async function fakeNative() {
  const requests: { path: string; body?: Record<string, unknown> }[] = []
  let appEnabled = false, failConnect = false, disconnected = 0, version = 1
  const statuses: Record<string, unknown> = {}
  const http = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : undefined
    requests.push({ path: url.pathname, ...(body ? { body } : {}) })
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/config') return response.end(JSON.stringify({ mcp: { 'foreman-code': { enabled: appEnabled } } }))
    if (url.pathname.endsWith('/disconnect')) { disconnected++; return response.end('true') }
    if (url.pathname === '/mcp' && request.method === 'POST') {
      if (failConnect) { response.statusCode = 500; return response.end(JSON.stringify(body)) }
      statuses[body.name] = { status: 'connected' }; return response.end(JSON.stringify(statuses))
    }
    if (url.pathname === '/mcp') return response.end(JSON.stringify({ 'foreman-code': { status: appEnabled ? 'connected' : 'disabled' }, ...statuses }))
    response.statusCode = 404; response.end('{}')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address() as { port: number }
  const server = {
    expectedVersion: '1.18.31', get generation() { return version },
    async ensure() {}, async dispose() {},
    async request(path: string, init?: RequestInit, abort?: AbortSignal, generation?: number) {
      if (generation !== undefined && generation !== version) throw new Error('native generation changed')
      return fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, signal: abort ?? null })
    },
  }
  return { server, requests, enableApp() { appEnabled = true }, failConnect() { failConnect = true },
    restart() { version++ }, get disconnected() { return disconnected },
    async close() { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())) },
  }
}

async function fixture(mode: 'read' | 'write' = 'write') {
  const backend = memoryService(), native = await fakeNative(), files = new Map<string, { bytes: Uint8Array; writable: boolean }>()
  let isolationFailure = false, snapshots = 0
  const host: OpenCodeExecutionFiles = {
    executionHostId: 'execution-b',
    async assertSourceIsolation() { if (isolationFailure) throw denied('FILE_SOURCE_WRITABLE') },
    async materialize(input) {
      files.set(input.handle, { bytes: Uint8Array.from(input.bytes), writable: input.writable })
      return { handle: input.handle, executionHostId: 'execution-b', path: `/execution/b/${input.handle}/${input.revision.filename}` }
    },
    async snapshot(handle) { snapshots++; return Uint8Array.from(files.get(handle)!.bytes) },
    async replace(handle, bytes, expectedSha256) {
      const entry = files.get(handle)
      if (!entry?.writable) throw denied('FILE_ARTIFACT_NOT_FOUND')
      if (sha256(entry.bytes) !== expectedSha256) throw denied('FILE_ARTIFACT_CONFLICT')
      entry.bytes = Uint8Array.from(bytes)
    },
    async remove(handle) { files.delete(handle) },
  }
  const options = { service: backend.service, host, server: native.server, endpoint: 'http://127.0.0.1:9876/mcp/files',
    appMcpServerName: 'foreman-code', maxFileBytes: limit, maxAttachments: 10 }
  const turn = new OpenCodeFileTurn(options)
  const admission: AcceptedOpenCodeFileTurn = { context: { ...context(), allowMutation: mode === 'write' },
    attachments: [backend.add()], directory: '/execution/project', executionHostId: 'execution-b', mode,
    expiresAt: new Date(Date.now() + 3_600_000) }
  return { backend, native, host, files, turn, admission, options,
    failIsolation() { isolationFailure = true }, get snapshots() { return snapshots },
    async close() { try { await turn.finish('terminal', signal()) } finally { await native.close() } },
  }
}
const publication = (id: string) => ({ commandId: randomUUID(), artifactId: id, scope, filename: 'returned.md', mediaType: 'text/markdown' as const })

/** Shared cases run under Vitest in-repo and node:test in the dependency-free focused runner. */
export function registerOpenCodeFileCases(test: (name: string, body: () => Promise<void>) => unknown): void {
  test('materializes pinned execution-host copies and registers only a scoped file credential', async () => {
    const f = await fixture()
    try {
      const result = await f.turn.prepare(f.admission, signal())
      const post = f.native.requests.find((request) => request.path === '/mcp' && request.body)!.body!
      const config = post.config as { headers: { Authorization: string }; url: string; type: string }
      assert.match(config.headers.Authorization, /^Bearer gql_file_[A-Za-z0-9_-]{43}$/)
      assert.equal(config.url, f.options.endpoint); assert.equal(config.type, 'remote')
      assert.deepEqual(f.backend.issued[0]!.context, f.admission.context)
      assert.ok(result.promptSuffix.includes('/execution/b/'))
      assert.ok(!result.promptSuffix.includes(f.backend.token))
      assert.ok(!JSON.stringify(post).includes('GRAPHQL_MCP_TOKEN'))
      assert.ok(!JSON.stringify(post).includes('FOREMAN_CODE_MCP_TOKEN'))
      assert.equal(f.backend.artifacts.values().next().value!.state, 'writing')
      assert.equal(f.native.requests.filter((r) => r.path.includes('/prompt')).length, 0)
    } finally { await f.close() }
  })
  test('reads bounded exact pinned ranges, including final expiry revalidation', async () => {
    const f = await fixture()
    try {
      const ref = f.backend.add('x'.repeat(150_001))
      f.admission.attachments = [ref]
      await f.turn.prepare(f.admission, signal())
      assert.deepEqual(f.backend.reads.map((r) => r.offset), [0, 65_536, 131_072, 150_001])
      assert.ok(f.backend.reads.every((r) => r.length <= 65_536))
    } finally { await f.close() }
  })
  test('passes image file:// parts with encoded names, never binary text', async () => {
    const f = await fixture()
    try {
      f.admission.attachments = [f.backend.add('image bytes', 'image/png', 'a #%.png')]
      const result = await f.turn.prepare(f.admission, signal())
      assert.equal(result.imageParts.length, 1)
      assert.equal(result.imageParts[0]!.mime, 'image/png')
      assert.match(result.imageParts[0]!.url, /^file:\/\/\/execution\/b\/.+\/a%20%23%25.png$/)
      assert.ok(!result.promptSuffix.includes(Buffer.from('image bytes').toString('base64')))
      assert.ok(!result.promptSuffix.includes('image bytes'))
    } finally { await f.close() }
  })
  test('does not render PDFs, Markdown, SVG or HTML as native image parts', async () => {
    const f = await fixture()
    try {
      const result = await f.turn.prepare(f.admission, signal())
      assert.deepEqual(result.imageParts, [])
      for (const mime of ['application/pdf', 'image/svg+xml', 'text/html']) {
        assert.equal(nativeImagePart({ handle: 'h', executionHostId: 'b', path: '/b/file' },
          { mediaType: mime } as FileRevision, 'b'), undefined)
      }
    } finally { await f.close() }
  })
  test('replayed preparation preserves edits, issues no token and repeats no native MCP setup', async () => {
    const f = await fixture()
    try {
      const first = await f.turn.prepare(f.admission, signal())
      const entry = f.files.values().next().value!; entry.bytes = Buffer.from('edited')
      assert.deepEqual(await f.turn.prepare(structuredClone(f.admission), signal()), first)
      assert.equal(f.backend.issued.length, 1); assert.equal(f.backend.copiesMade, 1)
      assert.equal(f.native.requests.filter((r) => r.path === '/mcp' && r.body).length, 1)
      assert.equal(Buffer.from(entry.bytes).toString(), 'edited')
    } finally { await f.close() }
  })
  test('conflicts on changed attachment pins under the same turn', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal())
      await assert.rejects(f.turn.prepare({ ...f.admission, attachments: [f.backend.add('other')] }, signal()), withCode('FILE_TURN_CONFLICT'))
      assert.equal(f.backend.issued.length, 1)
    } finally { await f.close() }
  })
  test('rejects API-host paths before issuing any file session', async () => {
    const f = await fixture()
    try {
      await assert.rejects(f.turn.prepare({ ...f.admission, executionHostId: 'api-host' }, signal()), withCode('FILE_EXECUTION_HOST_MISMATCH'))
      assert.equal(f.backend.issued.length, 0); assert.equal(f.native.requests.length, 0)
    } finally { await f.close() }
  })
  test('requires source isolation before native setup or token issuance', async () => {
    const f = await fixture()
    try {
      f.failIsolation()
      await assert.rejects(f.turn.prepare(f.admission, signal()))
      assert.equal(f.backend.issued.length, 0); assert.equal(f.native.requests.length, 0)
    } finally { await f.close() }
  })
  test('never enables the workflow App MCP to obtain file tools', async () => {
    const f = await fixture()
    try {
      f.native.enableApp()
      await assert.rejects(f.turn.prepare(f.admission, signal()), withCode('FILE_CHAT_ISOLATION_REQUIRED'))
      assert.equal(f.backend.issued.length, 0)
      assert.ok(f.native.requests.every((request) => !request.body))
    } finally { await f.close() }
  })
  test('refuses non-file endpoints, bearer URLs and cleartext remote credentials', async () => {
    const f = await fixture()
    try {
      for (const endpoint of ['http://127.0.0.1:9876/mcp', 'https://example.test/mcp/files?token=secret',
        'https://user:secret@example.test/mcp/files', 'http://remote.example/mcp/files']) {
        assert.throws(() => new OpenCodeFileTurn({ ...f.options, endpoint }))
      }
    } finally { await f.close() }
  })
  test('bounds attachment count without native side effects', async () => {
    const f = await fixture()
    try {
      await assert.rejects(f.turn.prepare({ ...f.admission, attachments: Array(11).fill(f.admission.attachments[0]) }, signal()), withCode('FILE_ATTACHMENT_LIMIT'))
      assert.equal(f.native.requests.length, 0)
    } finally { await f.close() }
  })
  test('rejects corrupt, oversized and incomplete pinned bytes and revokes setup credentials', async () => {
    for (const corrupt of [
      (v: Record<string, unknown>) => { v.contentBase64 = Buffer.from('bad').toString('base64') },
      (v: Record<string, unknown>) => { v.revision = { ...(v.revision as object), byteSize: limit + 1 } },
      (v: Record<string, unknown>) => { v.eof = false },
    ]) {
      const f = await fixture()
      try {
        f.backend.alterRead(corrupt)
        await assert.rejects(f.turn.prepare(f.admission, signal()))
        assert.equal(f.backend.revocations, 1); assert.equal(f.files.size, 0)
      } finally { await f.close() }
    }
  })
  test('rejects expiry on the final delivery read rather than exposing the copy', async () => {
    const f = await fixture()
    try {
      f.backend.alterRead((v) => { if (v.offset !== 0) v.status = 'unavailable' })
      await assert.rejects(f.turn.prepare(f.admission, signal()), withCode('FILE_ATTACHMENT_UNAVAILABLE'))
      assert.equal(f.files.size, 0)
    } finally { await f.close() }
  })
  test('read mode preserves accepted restrictions and does not create mutable artifacts', async () => {
    const f = await fixture('read')
    try {
      const result = await f.turn.prepare(f.admission, signal())
      assert.equal(f.backend.issued[0]!.context.allowMutation, false)
      assert.equal(f.backend.artifacts.size, 0)
      assert.ok([...f.files.values()].every((entry) => !entry.writable))
      assert.ok(result.promptSuffix.includes('mutation is unavailable'))
      await assert.rejects(f.turn.publish(f.backend.token, publication(randomUUID()), signal()), withCode('FILE_TOOL_DENIED'))
      assert.equal(f.snapshots, 0)
    } finally { await f.close() }
  })
  test('rejects a hidden mutation elevation in a read-mode admission', async () => {
    const f = await fixture('read')
    try {
      await assert.rejects(f.turn.prepare({ ...f.admission, context: { ...f.admission.context, allowMutation: true } }, signal()), withCode('FILE_SECURITY_CONFLICT'))
      assert.equal(f.backend.issued.length, 0)
    } finally { await f.close() }
  })
  test('snapshots edited registered bytes at publish and leaves source pins unchanged', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal())
      const id = [...f.files.keys()][0]!
      f.files.get(id)!.bytes = Buffer.from('# edited\n')
      const result = await f.turn.publish(f.backend.token, publication(id), signal())
      assert.equal(result.value.revision.origin, 'agent_output')
      assert.equal(f.backend.values.get(`${result.value.file.fileId}/${result.value.revision.revisionId}`)!.bytes.toString(), '# edited\n')
      assert.equal(f.backend.values.values().next().value!.bytes.toString(), '# original\n')
      assert.equal((await f.turn.publications()).length, 1)
    } finally { await f.close() }
  })
  test('publish lost acknowledgement replays; changed registered bytes conflict', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal())
      const id = [...f.files.keys()][0]!, input = publication(id)
      f.backend.losePublishAck()
      await assert.rejects(f.turn.publish(f.backend.token, input, signal()), /lost acknowledgement/)
      assert.equal((await f.turn.publish(f.backend.token, input, signal())).replayed, true)
      f.files.get(id)!.bytes = Buffer.from('changed')
      await assert.rejects(f.turn.publish(f.backend.token, input, signal()), withCode('FILE_REQUEST_CONFLICT'))
      assert.equal((await f.turn.publications()).length, 1)
    } finally { await f.close() }
  })
  test('restarts a failed writer lease without adopting another in-progress writer', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal())
      const id = [...f.files.keys()][0]!, input = publication(id)
      f.backend.artifacts.get(id)!.state = 'failed'
      assert.equal((await f.turn.publish(f.backend.token, input, signal())).replayed, false)
      const artifact = f.backend.artifacts.get(id)!
      artifact.state = 'writing'; artifact.writeId = randomUUID()
      await assert.rejects(f.turn.publish(f.backend.token, { ...input, commandId: randomUUID() }, signal()), withCode('FILE_ARTIFACT_BUSY'))
    } finally { await f.close() }
  })
  test('foreign credential, permanent destination and arbitrary paths fail before snapshots', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal())
      const id = [...f.files.keys()][0]!
      await assert.rejects(f.turn.publish('gql_file_' + 'a'.repeat(43), publication(id), signal()), withCode('FILE_CONTEXT_DENIED'))
      await assert.rejects(f.turn.publish(f.backend.token, { ...publication(id), scope: { kind: 'workspace_reference', workspaceId: 'w' } } as never, signal()), withCode('FILE_CONTEXT_DENIED'))
      await assert.rejects(f.turn.publish(f.backend.token, publication('/etc/passwd'), signal()), withCode('FILE_ARTIFACT_NOT_FOUND'))
      assert.equal(f.snapshots, 0)
    } finally { await f.close() }
  })
  test('on-demand copies have registered execution-host locations', async () => {
    const f = await fixture()
    try {
      f.admission.attachments = []
      const result = await f.turn.prepare(f.admission, signal())
      assert.equal(result.promptSuffix, '')
      const copy = await f.turn.createWorkingCopy(f.backend.token, { commandId: randomUUID(), source: f.backend.add('later'), destination: scope }, signal())
      assert.ok((await f.turn.workingCopyLocation(f.backend.token, copy.value.artifactId)).startsWith('/execution/b/'))
    } finally { await f.close() }
  })
  test('keeps an uncertain submission fenced and leaves its live files alone', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal()); f.turn.submissionAttempted()
      assert.throws(() => f.turn.submissionAttempted(), withCode('FILE_SUBMISSION_FENCED'))
      await assert.rejects(f.turn.retryCleanup(signal()), withCode('FILE_SUBMISSION_FENCED'))
      assert.equal(f.backend.revocations, 0); assert.equal(f.files.size, 1)
      await f.turn.finish('terminal', signal())
      assert.equal(f.backend.revocations, 1); assert.equal(f.files.size, 0)
    } finally { await f.native.close() }
  })
  test('does not misclassify a positive submission acknowledgement as definite rejection', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal()); f.turn.submissionAttempted(); f.turn.submissionAcknowledged()
      await assert.rejects(f.turn.finish('definite_rejection', signal()), withCode('FILE_SUBMISSION_INVALID'))
      assert.equal(f.backend.revocations, 0)
    } finally { await f.close() }
  })
  test('serializes ownership across helpers sharing one native controller', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal())
      const second = new OpenCodeFileTurn(f.options)
      await assert.rejects(second.prepare({ ...f.admission, context: context() }, signal()), withCode('FILE_NATIVE_PROCESS_BUSY'))
      assert.equal(f.backend.issued.length, 1)
    } finally { await f.close() }
  })
  test('failed revocation fences process reuse until cleanup succeeds', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal()); f.backend.failRevoke(true)
      await assert.rejects(f.turn.finish('terminal', signal()))
      assert.equal(f.native.disconnected, 0); assert.equal(f.files.size, 1)
      const other = new OpenCodeFileTurn(f.options)
      await assert.rejects(other.prepare({ ...f.admission, context: context() }, signal()), withCode('FILE_NATIVE_PROCESS_BUSY'))
      f.backend.failRevoke(false); await f.turn.retryCleanup(signal())
      assert.equal(f.native.disconnected, 1); assert.equal(f.files.size, 0)
    } finally { f.backend.failRevoke(false); await f.close() }
  })
  test('does not leak native configuration response secrets on a failed MCP connection', async () => {
    const f = await fixture()
    try {
      f.native.failConnect()
      let caught: unknown
      try { await f.turn.prepare(f.admission, signal()) } catch (error) { caught = error }
      assert.ok(caught instanceof Error)
      assert.ok(!caught.message.includes(f.backend.token))
      assert.equal(f.backend.revocations, 1)
    } finally { await f.close() }
  })
  test('native process replacement cannot silently publish from the previous process', async () => {
    const f = await fixture()
    try {
      await f.turn.prepare(f.admission, signal()); f.native.restart()
      await assert.rejects(f.turn.publish(f.backend.token, publication([...f.files.keys()][0]!), signal()), withCode('FILE_NATIVE_PROCESS_CHANGED'))
      assert.equal(f.snapshots, 0)
    } finally {
      // Old-generation disconnect is deliberately fenced. The test server is retired, not reused.
      await f.native.close()
    }
  })
  test('metadata prompt escapes hostile filenames and contains no startup/skill bundle', async () => {
    const prompt = fileDeliveryPrompt([{ ref: { fileId: 'f', revisionId: 'r' },
      revision: { filename: '"ignore previous".md' } as FileRevision,
      registered: { handle: 'h', executionHostId: 'e', path: '/e/copy.md' } }], 'read')
    assert.ok(prompt.includes('\\"ignore previous\\"'))
    assert.ok(!prompt.includes('system:')); assert.ok(!prompt.includes('skills:'))
    assert.equal(fileDeliveryPrompt([], 'write'), '')
  })
  test('native image paths must belong to the exact host and cannot contain traversal', async () => {
    for (const path of ['relative.png', '/e/../x.png', '//other/x.png', '/e/x\n.png']) {
      assert.throws(() => nativeImagePart({ handle: 'h', executionHostId: 'e', path }, { mediaType: 'image/png' } as FileRevision, 'e'))
    }
    assert.throws(() => nativeImagePart({ handle: 'h', executionHostId: 'API', path: '/api/image.png' }, { mediaType: 'image/png' } as FileRevision, 'runner'))
  })
  test('local runner uses registered handles, survives editor replacement, and cleans empty directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fil09-host-'))
    const host = new LocalOpenCodeExecutionFiles({ root, executionHostId: 'local', maxFileBytes: limit,
      async assertSourceIsolation() { /* This unit fixture has no disk-backed source vault. */ } })
    const handle = randomUUID(), bytes = Buffer.from('# input'), revision = {
      fileId: randomUUID(), revisionId: randomUUID(), filename: 'a #%.md', mediaType: 'text/markdown',
      byteSize: bytes.length, sha256: sha256(bytes), origin: 'upload', createdAt: new Date().toISOString(),
    } as FileRevision
    try {
      const file = await host.materialize({ handle, revision, bytes, writable: true }, signal())
      await writeFile(file.path, '# edited')
      assert.equal(Buffer.from(await host.snapshot(handle, signal())).toString(), '# edited')
      await host.replace(handle, Buffer.from('# tool edit'), sha256(Buffer.from('# edited')), signal())
      assert.equal((await readFile(file.path)).toString(), '# tool edit')
      await assert.rejects(host.replace(handle, Buffer.from('# stale replacement'), sha256(bytes), signal()),
        withCode('FILE_ARTIFACT_CONFLICT'))
      assert.equal((await readFile(file.path)).toString(), '# tool edit')
      assert.deepEqual(await host.materialize({ handle, revision, bytes, writable: true }, signal()), file)
      assert.equal((await readFile(file.path)).toString(), '# tool edit')
      await host.remove(handle); assert.deepEqual(await readdir(root), [])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('contract-valid long Unicode display names do not exceed native filename byte limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fil09-unicode-'))
    const host = new LocalOpenCodeExecutionFiles({ root, executionHostId: 'local', maxFileBytes: limit,
      async assertSourceIsolation() {} })
    const bytes = Buffer.from('x'), handle = randomUUID()
    const revision = { fileId: randomUUID(), revisionId: randomUUID(), filename: '文'.repeat(120) + '.md',
      mediaType: 'text/markdown', byteSize: 1, sha256: sha256(bytes), origin: 'upload', createdAt: new Date().toISOString() } as FileRevision
    try {
      const file = await host.materialize({ handle, revision, bytes, writable: true }, signal())
      assert.ok(file.path.endsWith('/attachment.md'))
      assert.equal(Buffer.from(await host.snapshot(handle, signal())).toString(), 'x')
      await host.remove(handle)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('local runner rejects symlink and hardlink publication rather than reading outside paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fil09-links-'))
    const host = new LocalOpenCodeExecutionFiles({ root, executionHostId: 'local', maxFileBytes: limit,
      async assertSourceIsolation() {} })
    const make = async () => {
      const bytes = Buffer.from('x'), handle = randomUUID()
      const revision = { fileId: randomUUID(), revisionId: randomUUID(), filename: 'copy.md', mediaType: 'text/markdown',
        byteSize: 1, sha256: sha256(bytes), origin: 'upload', createdAt: new Date().toISOString() } as FileRevision
      return { handle, file: await host.materialize({ handle, revision, bytes, writable: true }, signal()) }
    }
    try {
      const outside = join(root, 'outside.md'); await writeFile(outside, 'private')
      const a = await make(); await rm(a.file.path); await symlink(outside, a.file.path)
      await assert.rejects(host.replace(a.handle, Buffer.from('overwrite'), sha256(Buffer.from('x')), signal()))
      await assert.rejects(host.snapshot(a.handle, signal())); await host.remove(a.handle)
      const b = await make(); await rm(b.file.path); await link(outside, b.file.path)
      await assert.rejects(host.replace(b.handle, Buffer.from('overwrite'), sha256(Buffer.from('x')), signal()),
        withCode('FILE_ARTIFACT_INVALID'))
      await assert.rejects(host.snapshot(b.handle, signal()), withCode('FILE_ARTIFACT_INVALID')); await host.remove(b.handle)
      assert.equal((await readFile(outside)).toString(), 'private')
      await assert.rejects(host.snapshot('/etc/passwd', signal()), withCode('FILE_ARTIFACT_NOT_FOUND'))
      await assert.rejects(host.replace('/etc/passwd', Buffer.from('overwrite'), sha256(Buffer.from('x')), signal()),
        withCode('FILE_ARTIFACT_NOT_FOUND'))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('source checks reject an unverified native PID and empty path inventory', async () => {
    await assert.rejects(assertProtectedSourcePaths(process.pid, [], signal()), withCode('FILE_SOURCE_ISOLATION_REQUIRED'))
    await assert.rejects(assertProtectedSourcePaths(-1, ['/etc/passwd'], signal()), withCode('FILE_SOURCE_ISOLATION_REQUIRED'))
  })
  test('delivery abort performs no registration or byte publication', async () => {
    const f = await fixture()
    try {
      await assert.rejects(f.turn.prepare(f.admission, AbortSignal.abort()))
      assert.equal(f.backend.issued.length, 0); assert.equal(f.files.size, 0)
    } finally { await f.close() }
  })
}
