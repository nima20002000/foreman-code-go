import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import Fastify from 'fastify'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@graphql/contracts/files'
import { DomainError } from '../../src/modules/errors.js'
import { registerFileToolsMcp } from '../../src/modules/files/tools/mcp.js'
import { ManagedOpenCodeServer, QUALIFIED_OPENCODE_VERSION } from '../../src/modules/harnesses/opencodeTransport.js'
import { createOpenCodeFileMcpFacade } from '../../src/modules/harnesses/opencodeFiles/facade.js'
import { LocalOpenCodeExecutionFiles } from '../../src/modules/harnesses/opencodeFiles/host.js'
import { readPinnedAttachment, sha256 } from '../../src/modules/harnesses/opencodeFiles/attachments.js'
import { OpenCodeFileTurn } from '../../src/modules/harnesses/opencodeFiles/turn.js'
import { fileToolFixture } from './fileTools.js'

const { values } = parseArgs({ options: { model: { type: 'string' }, binary: { type: 'string', default: 'opencode' },
  output: { type: 'string', default: 'fil09-returned.md' } } })
assert.equal(process.platform, 'linux', 'This runner-side smoke currently qualifies Linux only.')
assert.notEqual(process.geteuid?.(), 0, 'Run the native smoke as a non-root user.')
assert.ok(values.model?.includes('/'), 'Supply --model provider/model using your configured native provider.')
assert.match(QUALIFIED_OPENCODE_VERSION, /^1\.18\./)
const [providerID, ...modelPath] = (values.model ?? '').split('/')
const modelID = modelPath.join('/')
assert.ok(providerID && modelID)
const directory = await mkdtemp(join(tmpdir(), 'graphql-fil09-smoke-'))
const root = join(directory, 'attachments')
await mkdir(root, { mode: 0o700 })
const f = await fileToolFixture()
f.advance(Date.now() - f.clock().getTime())
const marker = `FIL-09-returned-${randomUUID()}`
const original = '# FIL-09 source\n\nReturn an edited copy.\n'
const source = await f.upload(original)
const server = new ManagedOpenCodeServer({ binary: values.binary, workingDirectory: directory,
  ownerAgentId: 'agent-a', appMcpAccess: 'none', appMcpServerName: 'graphql' })
const app = Fastify({ logger: false })
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
  .send({ error: 'File request rejected.' }))
let turn: OpenCodeFileTurn | undefined
registerFileToolsMcp(app, createOpenCodeFileMcpFacade(f.service, () => {
  assert.ok(turn, 'The native file turn is not ready.'); return turn
}))
const abort = AbortSignal.timeout(180_000)
const native = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
  const response = await server.request(`${path}?directory=${encodeURIComponent(directory)}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }, abort)
  assert.ok(response.ok, `Native OpenCode request failed (${response.status}); the prompt will not be replayed.`)
  return await response.json() as Record<string, unknown>
}
let completed = false
try {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  await server.ensure(abort)
  // This smoke explicitly accepts writes ONLY to its disposable project, with shell/subagents denied.
  const session = await native('/session', { title: 'FIL-09 isolated file smoke', permission: [
    { permission: '*', pattern: '*', action: 'deny' },
    // OpenCode matches read/edit patterns relative to the project; paths outside it are
    // separately gated by external_directory, which the deny-all rule above keeps denied.
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'edit', pattern: '*', action: 'allow' },
    { permission: 'graphql_files_*', pattern: '*', action: 'allow' },
  ] })
  assert.equal(typeof session.id, 'string')
  const executionHostId = `smoke:${hostname()}:${process.pid}`
  const host = new LocalOpenCodeExecutionFiles({ executionHostId, root, maxFileBytes: MAX_FILE_BYTES,
    async assertSourceIsolation() {
      // Real FIL-05 services, but ALL source bytes are in MemoryBytes, not filesystem paths.
      // This is not an attestation usable with production disk-backed reference files.
      assert.equal(f.bytes.objects.size > 0, true)
    } })
  turn = new OpenCodeFileTurn({ service: f.service, host, server, appMcpServerName: 'graphql',
    endpoint: `http://127.0.0.1:${address.port}/mcp/files`, maxFileBytes: MAX_FILE_BYTES,
    maxAttachments: MAX_MESSAGE_ATTACHMENTS })
  const turnId = randomUUID()
  const prepared = await turn.prepare({ context: { ...f.context, nativeSessionId: session.id as string, turnId },
    attachments: [source], mode: 'write', directory, executionHostId,
    expiresAt: new Date(f.clock().getTime() + 600_000) }, abort)
  turn.submissionAttempted()
  // Native image parts would be in the same parts array. Markdown remains a path, not pasted content.
  // Like production: submit asynchronously, then wait for the terminal message. A synchronous
  // /message call would hit the transport's 30s per-request cap during a real agent turn.
  const messageID = `msg_${sha256(turnId).slice(0, 32)}`
  const sessionPath = `/session/${encodeURIComponent(session.id as string)}`
  const submitted = await server.request(`${sessionPath}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    messageID, agent: 'build', model: { providerID, modelID },
    parts: [{ type: 'text', text: `Read the attached Markdown with the native Read tool. Use the native Edit tool to append\n${marker}\n`+
      'to its working copy. Then call the available files.publish_result tool with its artifactId, a new commandId, '+
      'filename returned.md, mediaType text/markdown, and the exact scope in the file MCP instructions. Do not use shell commands.\n'+
      prepared.promptSuffix }, ...prepared.imageParts],
  }) }, abort)
  assert.ok(submitted.ok, `Native OpenCode prompt submission failed (${submitted.status}); it will not be replayed.`)
  turn.submissionAcknowledged()
  type NativeMessage = { info?: { role?: string; parentID?: string; finish?: string; error?: unknown; time?: { completed?: number } } }
  let info: NativeMessage['info']
  while (!info) {
    abort.throwIfAborted()
    const response = await server.request(`${sessionPath}/message?directory=${encodeURIComponent(directory)}`, { method: 'GET' }, abort)
    assert.ok(response.ok, `Native OpenCode message read failed (${response.status}).`)
    const reply = (await response.json() as NativeMessage[]).find((entry) => entry.info?.role === 'assistant'
      && entry.info.parentID === messageID
      // Each tool step is its own completed message; the turn ends at a non-tool-call finish.
      && (entry.info.error || (typeof entry.info.time?.completed === 'number' && entry.info.finish !== undefined && entry.info.finish !== 'tool-calls')))
    if (reply) info = reply.info
    else await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  assert.ok(info && !info.error && typeof info.time?.completed === 'number', 'No confirmed successful native terminal message.')
  completed = true
  const publications = await turn.publications()
  assert.equal(publications.length, 1, 'The native agent must publish exactly one returned file through FIL-05.')
  const readToken = await f.issue({ nativeSessionId: session.id as string, turnId, allowMutation: false, allowedTools: ['files.read'] })
  const published = await readPinnedAttachment(f.service, readToken, publications[0]!, MAX_FILE_BYTES, abort)
  assert.equal(published.revision.mediaType, 'text/markdown')
  assert.ok(Buffer.from(published.bytes).toString('utf8').includes(marker), 'The returned revision does not contain the native edit.')
  const unchanged = await readPinnedAttachment(f.service, readToken, source, MAX_FILE_BYTES, abort)
  assert.equal(Buffer.from(unchanged.bytes).toString('utf8'), original, 'Native edits changed the immutable source.')
  assert.notEqual(publications[0]!.revisionId, source.revisionId)
  const output = resolve(values.output)
  await writeFile(output, published.bytes, { flag: 'wx', mode: 0o600 })
  await f.sessions.revoke(readToken)
  await turn.finish('terminal', AbortSignal.timeout(10_000))
  console.log(JSON.stringify({ ok: true, nativeVersion: QUALIFIED_OPENCODE_VERSION,
    output, ...publications[0], sha256: published.revision.sha256 }, null, 2))
} finally {
  // Stop this isolated native process before dropping its fixture. Unknown submissions are never retried.
  await server.dispose()
  if (turn && completed) await turn.finish('terminal', AbortSignal.timeout(10_000)).catch(() => undefined)
  f.tools.sessions.clear() // These are fixture-only credentials, not the application session store.
  await app.close()
  await rm(directory, { recursive: true, force: true })
}
