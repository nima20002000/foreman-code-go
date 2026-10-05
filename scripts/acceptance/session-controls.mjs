import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

// Run against the integrated production-wired app and twelve separately owned native chats.
// Tokens are referenced by environment-variable name in the manifest and never written to the report.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/acceptance/session-controls.mjs <matrix.json> <new-evidence.json>')
const matrix = JSON.parse(await readFile(process.argv[2], 'utf8'))
const source = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../', import.meta.url)) })
assert.equal(matrix.sourceCommit, source.stdout.trim(), 'The source commit does not match this checkout.')
const pkg = JSON.parse(await readFile(new URL('../../apps/api/package.json', import.meta.url), 'utf8'))
assert.equal(matrix.rows.length, 12, 'Provide Operator and node chats for each harness on main and a paired worker.')
assert.ok(matrix.restart?.command && Array.isArray(matrix.restart.args), 'Provide the orchestrator’s application restart command.')
assert.match(matrix.sourceCommit, /^[a-f0-9]{40}$/)
const base = new URL(matrix.baseUrl)
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use the reviewed local app instance.')
const cases = new Set(matrix.rows.map(row => `${row.harness}:${row.role}:${row.hostKind}`))
for (const harness of ['codex', 'claude', 'opencode']) {
  for (const role of ['operator', 'agent']) for (const host of ['main', 'device']) {
    assert.ok(cases.has(`${harness}:${role}:${host}`), `Missing ${harness}:${role}:${host}`)
  }
}
const evidence = { sdkPins: { codex: pkg.dependencies['@openai/codex'], claude: pkg.dependencies['@anthropic-ai/claude-agent-sdk'],
  opencode: pkg.dependencies['@opencode-ai/sdk'] }, sourceCommit: matrix.sourceCommit, baseUrl: base.origin, rows: [],
  nativeQualification: false }

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
async function settled(row, requestId) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const state = await read(row)
    if (state.compaction?.requestId === requestId && ['completed', 'no-op', 'failed'].includes(state.compaction.status)) return state
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Native compaction did not settle.')
}
async function update(row, input) {
  const state = await read(row)
  return request(endpoint(row, '/session-controls'), row, { ...input,
    requestId: randomUUID(), expectedRevision: state.revision })
}
async function restart(row) {
  await promisify(execFile)(matrix.restart.command, matrix.restart.args, {
    cwd: matrix.restart.cwd, timeout: 180000, maxBuffer: 1024 * 1024,
  })
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    try { return await read(row) } catch {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  throw new Error('Application did not recover after restart.')
}
function activities(value) { return value.state?.activities ?? value.activities ?? [] }
function boundaries(value) { return activities(value).filter(activity => activity.title === 'Context compacted') }
async function preferences(row, desired) {
  await update(row, { kind: 'preferences', preferences: desired })
  await send(row, 'Reply briefly without changing any files.')
  const state = await idle(row)
  assert.deepEqual(state.desired, desired)
  assert.deepEqual(state.applied, desired, 'The native session did not apply the accepted settings.')
  assert.equal(state.applicability, 'applied')
  return state
}
async function checkedProfile(row) {
  assert.ok(row.profileCheckRequest, 'Supply an explicitly authorized qualification request for this actual profile.')
  const checked = await request(new URL('/api/management/harness-instances/check', base), row,
    { ...row.profileCheckRequest, commandId: randomUUID() })
  assert.equal(checked.value.instanceId, row.nativeProfile)
  assert.equal(checked.value.target.hostRef.kind, row.hostKind)
  assert.equal(checked.proof.authenticated, true)
  assert.equal(checked.proof.compatible, true)
  assert.equal(checked.proof.qualified, true, 'The actual installed native security/policy check did not qualify.')
  if (row.hostKind === 'device') assert.equal(checked.value.target.hostRef.deviceId, row.nativeHost)
  return checked.proof
}
for (const row of matrix.rows) {
  assert.ok(row.nativeHost && row.nativeProfile && row.nativeCliVersion && row.model,
    'Record the measured native host, profile, CLI version and selected model.')
  const nativeProof = await checkedProfile(row)
  assert.ok(Array.isArray(row.compactionInputs) && row.compactionInputs.length, 'Supply native context-building messages.')
  const marker = randomUUID()
  const beforeRun = row.runReadPath ? await request(new URL(row.runReadPath, base), row) : null
  const normal = await send(row, `Remember this session marker and repeat it exactly once: ${marker}`)
  for (const content of row.compactionInputs) await send(row, content)
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
  assert.equal(compacted.compaction?.status, 'completed', 'The native session must produce a manual compaction boundary.')
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
  assert.equal(afterPlan.appliedMode, 'plan', 'The native Plan control was not acknowledged before the task.')
  assert.equal(messages(await transcript(row)).filter(message => message.requestId === task.input.requestId && message.role === 'user').length, 1)
  const exited = await request(endpoint(row, '/session-controls'), row, {
    kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: afterPlan.revision,
  })
  assert.equal(exited.desiredMode, 'regular')
  await send(row, 'Reply with only the session marker from the earlier message.')
  const reply = messages(await transcript(row)).filter(message => message.role === 'assistant').at(-1)
  assert.ok(reply?.content.includes(marker), 'The follow-up did not retain the prior session context.')
  if (beforeRun) assert.deepEqual(await request(new URL(row.runReadPath, base), row), beforeRun, 'Chat controls changed the selected Run.')
  let desired = (await idle(row)).desired
  if (row.harness === 'codex') {
    const controls = await read(row)
    assert.ok(controls.capabilities.contextBudgets.length, 'Codex must advertise a qualified budget independently of its override.')
    desired = { ...desired, contextBudget: controls.capabilities.contextBudgets[0] }
    await preferences(row, desired)
  }
  if (row.harness === 'claude') {
    const controls = await read(row)
    assert.ok(controls.capabilities.modelCapacity >= 100000)
    assert.ok(controls.capabilities.contextProfiles.length, 'Claude must expose this model/account’s qualified profiles.')
    desired = { ...desired, autoCompact: 'off', autoCompactTokens: 100000 }
    await preferences(row, desired)
    for (const content of row.compactionInputs) await send(row, content)
    const manual = await update(row, { kind: 'compact' })
    assert.equal((await settled(row, manual.compaction.requestId)).compaction.status, 'completed',
      'Manual compact must still work with automatic compaction Off.')
    for (const profile of controls.capabilities.contextProfiles) {
      await preferences(row, { ...desired, contextProfile: profile.id })
      assert.equal((await read(row)).capabilities.modelCapacity, profile.capacity)
    }
    desired = { ...desired, autoCompact: 'on', contextProfile: null }
    await preferences(row, desired)
    assert.ok(Array.isArray(row.autoCompactInputs) && row.autoCompactInputs.length,
      'Supply enough real native context to reach the accepted automatic budget.')
    const count = boundaries(await transcript(row)).length
    for (const content of row.autoCompactInputs) await send(row, content)
    assert.ok(boundaries(await transcript(row)).length > count, 'No native automatic compaction boundary was observed.')
    await preferences(row, { ...desired, autoCompact: 'default', autoCompactTokens: null })
    desired = (await read(row)).desired
  }
  await update(row, { kind: 'save-default', preferences: desired })
  assert.ok(row.futureDefaultsReadPath, 'Supply an uninitialized future-chat defaults read path in this scope.')
  assert.deepEqual((await request(new URL(row.futureDefaultsReadPath, base), row)).desired, desired)
  const restartBefore = await idle(row)
  await restart(row)
  assert.deepEqual((await read(row)).desired, restartBefore.desired)
  assert.equal((await read(row)).nativeSessionId, before.nativeSessionId)
  await send(row, 'Reply with the remembered session marker only.')
  const after = await idle(row)
  assert.deepEqual(after.applied, desired, 'Restart did not restore the durable accepted preferences.')
  assert.equal(after.appliedMode, 'regular')

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
    const target = { conversationId: row.conversationId, ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}) }
    const write = await client.callTool({ name: `${row.role}_chat_controls_update`, arguments: { ...target,
      request: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: parity.structuredContent.revision } } })
    assert.ok(!write.isError)
    assert.equal((await read(row)).desiredMode, 'plan')
    const restore = await read(row)
    const preferencesWrite = await client.callTool({ name: `${row.role}_chat_controls_update`, arguments: { ...target,
      request: { kind: 'preferences', preferences: desired, requestId: randomUUID(), expectedRevision: restore.revision } } })
    assert.ok(!preferencesWrite.isError)
    const defaultsWrite = await client.callTool({ name: `${row.role}_chat_controls_update`, arguments: { ...target,
      request: { kind: 'save-default', preferences: desired, requestId: randomUUID(),
        expectedRevision: (await read(row)).revision } } })
    assert.ok(!defaultsWrite.isError)
    await update(row, { kind: 'mode', mode: 'regular' })
    const deniedToken = process.env[row.deniedMcpTokenEnv]
    assert.ok(deniedToken, 'Supply a caller without the matching write authority.')
    const denied = new Client({ name: 'session-controls-denied', version: '1' })
    try {
      await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
        authProvider: { token: async () => deniedToken },
      }))
      const rejected = await denied.callTool({ name: `${row.role}_chat_controls_update`, arguments: { ...target,
        request: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: (await read(row)).revision } } })
      assert.equal(rejected.isError, true)
      assert.equal((await read(row)).desiredMode, 'regular')
    } finally { await denied.close() }
    for (const content of row.compactionInputs) await send(row, content)
    const compactInput = { kind: 'compact', requestId: randomUUID(), expectedRevision: (await read(row)).revision }
    const lost = new AbortController()
    const submission = fetch(endpoint(row, '/session-controls'), { method: 'POST', headers: headers(row),
      body: JSON.stringify(compactInput), signal: lost.signal }).catch(error => {
      if (!lost.signal.aborted) throw error
    })
    const deadline = Date.now() + 180000
    while ((await read(row)).compaction?.requestId !== compactInput.requestId) {
      assert.ok(Date.now() < deadline, 'The response-loss command was not admitted.')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    lost.abort()
    await submission
    await settled(row, compactInput.requestId)
    await restart(row)
    const retry = await request(endpoint(row, '/session-controls'), row, compactInput)
    assert.equal(retry.compaction.requestId, compactInput.requestId)
    assert.equal(retry.compaction.status, 'completed')
    assert.equal(retry.compactions.filter(compaction => compaction.requestId === compactInput.requestId).length, 1)
    assert.equal(retry.nativeSessionId, before.nativeSessionId)
  } finally { await client.close() }
  const finalNativeProof = await checkedProfile(row)
  assert.deepEqual(finalNativeProof.target, nativeProof.target)
  assert.equal(finalNativeProof.configurationFingerprint, nativeProof.configurationFingerprint)
  evidence.rows.push({ harness: row.harness, role: row.role, host: row.nativeHost, profile: row.nativeProfile,
    model: row.model, nativeCliVersion: row.nativeCliVersion, normalRequestId: normal.input.requestId,
    nativeSessionId: after.nativeSessionId, compactRequestId: command.requestId, compactResult: compacted.compaction,
    hostKind: row.hostKind, nativeProof, finalNativeProof, beforeContext: before.context, afterContext: after.context, planTaskRequestId: task.input.requestId,
    appliedMode: after.appliedMode, preferences: { desired: after.desired, applied: after.applied } })
}
evidence.nativeQualification = true
await writeFile(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write('Twelve production native control paths, policy checks and restart recovery qualified.\n')
