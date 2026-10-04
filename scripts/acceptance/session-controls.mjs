import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

// Run against the integrated production-wired app and six separately owned native chats.
// Tokens are referenced by environment-variable name in the manifest and never written to the report.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/acceptance/session-controls.mjs <matrix.json> <new-evidence.json>')
const matrix = JSON.parse(await readFile(process.argv[2], 'utf8'))
const source = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../', import.meta.url)) })
assert.equal(matrix.sourceCommit, source.stdout.trim(), 'The source commit does not match this checkout.')
const pkg = JSON.parse(await readFile(new URL('../../apps/api/package.json', import.meta.url), 'utf8'))
assert.equal(matrix.rows.length, 6, 'Provide one Operator and one node chat for each harness.')
assert.match(matrix.sourceCommit, /^[a-f0-9]{40}$/)
const base = new URL(matrix.baseUrl)
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use the reviewed local app instance.')
const cases = new Set(matrix.rows.map(row => `${row.harness}:${row.role}`))
for (const harness of ['codex', 'claude', 'opencode']) {
  for (const role of ['operator', 'agent']) assert.ok(cases.has(`${harness}:${role}`), `Missing ${harness}:${role}`)
}
const evidence = { sdkPins: { codex: pkg.dependencies['@openai/codex'], claude: pkg.dependencies['@anthropic-ai/claude-agent-sdk'],
  opencode: pkg.dependencies['@opencode-ai/sdk'] }, sourceCommit: matrix.sourceCommit, baseUrl: base.origin, rows: [],
  nativeQualification: false, remaining: ['Browser accessibility and attachment/reconnect walkthrough',
    'Claude automatic-compaction boundary and native effective budget/profile checks',
    'Configured paired-worker matrix and native security/approval policy readback'] }

function endpoint(row, suffix) {
  const path = row.role === 'operator' ? `/api/operator/conversations/${encodeURIComponent(row.conversationId)}`
    : `/api/workspaces/${encodeURIComponent(row.workspaceId)}/agent-chat/conversations/${encodeURIComponent(row.conversationId)}`
  return new URL(`${path}${suffix}`, base)
}
function headers(row) {
  const token = row.httpTokenEnv ? process.env[row.httpTokenEnv] : undefined
  if (row.httpTokenEnv) assert.ok(token, `Missing ${row.httpTokenEnv}`)
  return { 'content-type': 'application/json', origin: base.origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }
}
async function request(url, row, body) {
  const response = await fetch(url, { headers: headers(row), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(180000) })
  assert.ok(response.ok, `Application request failed: ${response.status}`)
  return response.json()
}
const read = row => request(endpoint(row, '/session-controls'), row)
async function idle(row) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const state = await read(row)
    if (!state.busyReason) return state
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('The native conversation did not become idle.')
}
async function transcript(row) {
  if (row.role === 'operator') return request(endpoint(row, ''), row)
  return request(new URL(row.readPath, base), row)
}
function messages(value) { return value.state?.messages ?? value.messages }
async function send(row, content, sessionMode) {
  const input = { ...row.sendRequest, requestId: randomUUID(), content,
    ...(sessionMode ? { sessionMode } : {}) }
  const accepted = await request(new URL(row.sendPath, base), row, input)
  await idle(row)
  return { input, accepted }
}
for (const row of matrix.rows) {
  assert.ok(row.nativeHost && row.nativeProfile && row.nativeCliVersion && row.model,
    'Record the measured native host, profile, CLI version and selected model.')
  const marker = randomUUID()
  const beforeRun = row.runReadPath ? await request(new URL(row.runReadPath, base), row) : null
  const normal = await send(row, `Remember this session marker and repeat it exactly once: ${marker}`)
  const before = await idle(row)
  assert.ok(before.nativeSessionId, 'A normal text turn must establish a native session.')
  assert.equal(before.nativeProviderVersion, row.nativeCliVersion, 'The live session differs from the measured native CLI.')
  assert.equal(before.capabilities.model, row.model, 'The native manager differs from the selected model.')
  assert.equal(before.capabilities.compact.supported, true)
  assert.equal(before.capabilities.plan.supported, true)
  const beforeTranscript = messages(await transcript(row))
  const command = { kind: 'compact', requestId: randomUUID(), expectedRevision: before.revision }
  let compacted = await request(endpoint(row, '/session-controls'), row, command)
  if (['accepted', 'running', 'uncertain'].includes(compacted.compaction?.status)) {
    const deadline = Date.now() + 180000
    do {
      compacted = await read(row)
      if (['completed', 'no-op', 'failed'].includes(compacted.compaction?.status)) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    } while (Date.now() < deadline)
  }
  assert.ok(['completed', 'no-op'].includes(compacted.compaction?.status), 'Native compaction is not confirmed.')
  assert.equal(compacted.compaction.requestId, command.requestId)
  assert.equal(compacted.nativeSessionId, before.nativeSessionId)
  const replay = await request(endpoint(row, '/session-controls'), row, command)
  assert.equal(replay.compaction.requestId, command.requestId)
  assert.deepEqual(messages(await transcript(row)), beforeTranscript, 'Compaction changed application message history.')
  const turnCount = messages(await transcript(row)).length
  const planned = await request(endpoint(row, '/session-controls'), row, {
    kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: replay.revision,
  })
  assert.equal(planned.desiredMode, 'plan')
  assert.equal(messages(await transcript(row)).length, turnCount, 'Bare Plan created a model message.')
  const task = await send(row, '/plan Describe a short read-only inspection plan. Do not modify files.', 'plan')
  const duplicate = await request(new URL(row.sendPath, base), row, task.input)
  assert.equal(duplicate.replayed, true)
  const afterPlan = await idle(row)
  const exited = await request(endpoint(row, '/session-controls'), row, {
    kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: afterPlan.revision,
  })
  assert.equal(exited.desiredMode, 'regular')
  await send(row, 'Reply with only the session marker from the earlier message.')
  const reply = messages(await transcript(row)).filter(message => message.role === 'assistant').at(-1)
  assert.ok(reply?.content.includes(marker), 'The follow-up did not retain the prior session context.')
  if (beforeRun) assert.deepEqual(await request(new URL(row.runReadPath, base), row), beforeRun, 'Chat controls changed the selected Run.')
  const after = await idle(row)
  assert.equal(after.nativeSessionId, before.nativeSessionId)
  const token = process.env[row.mcpTokenEnv]
  assert.ok(token, 'Provide the explicit MCP writer grant for this chat.')
  const client = new Client({ name: 'session-control-native-acceptance', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { authProvider: { token: async () => token } }))
    const parity = await client.callTool({ name: `${row.role}_chat_controls_get`, arguments: {
      conversationId: row.conversationId, ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    } })
    assert.ok(!parity.isError)
    assert.equal(parity.structuredContent.nativeSessionId, after.nativeSessionId)
    assert.equal(parity.structuredContent.desiredMode, 'regular')
  } finally { await client.close() }
  evidence.rows.push({ harness: row.harness, role: row.role, host: row.nativeHost, profile: row.nativeProfile,
    model: row.model, nativeCliVersion: row.nativeCliVersion, normalRequestId: normal.input.requestId,
    nativeSessionId: after.nativeSessionId, compactRequestId: command.requestId, compactResult: compacted.compaction,
    beforeContext: before.context, afterContext: after.context, planTaskRequestId: task.input.requestId,
    appliedMode: after.appliedMode, preferences: { desired: after.desired, applied: after.applied } })
}
await writeFile(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write('Six native control paths checked. Full qualification still requires the remaining matrix items in the report.\n')
