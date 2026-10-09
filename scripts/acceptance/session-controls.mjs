import { decodeMcpToolResult } from '../../packages/contracts/dist/operatorMcp.js'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { sessionControlHeaders } from './session-control-client.mjs'
import { assertCodexContextBudget } from './native-context-budget.mjs'
import { sessionControlProduct } from './session-control-product.mjs'
import { sessionControlTransport } from './session-control-transport.mjs'

// Run against the integrated production-wired app and eight separately owned native chats.
// Tokens are referenced by environment-variable name in the manifest and never written to the report.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/acceptance/session-controls.mjs <matrix.json> <new-evidence.json>')
const matrix = JSON.parse(await readFile(process.argv[2], 'utf8'))
const source = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../', import.meta.url)) })
assert.equal(matrix.sourceCommit, source.stdout.trim(), 'The source commit does not match this checkout.')
const pkg = JSON.parse(await readFile(new URL('../../apps/api/package.json', import.meta.url), 'utf8'))
assert.equal(matrix.rows.length, 8, 'Provide Operator and node chats for each harness on main and a paired worker.')
for (const row of matrix.rows) {
  assert.equal(row.mcpTokenEnv, matrix.mcpTokenEnv, 'Use the same creating MCP caller for the prepared chats.')
  if (row.harness === 'claude') assert.ok(['haiku', 'claude-haiku-4-5-20251001'].includes(row.model),
    'Claude acceptance chats must explicitly use the qualified Haiku model.')
}
assert.ok(matrix.restart?.command && Array.isArray(matrix.restart.args), 'Provide the orchestrator’s application restart command.')
assert.match(matrix.sourceCommit, /^[a-f0-9]{40}$/)
const base = new URL(matrix.baseUrl)
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use the reviewed local app instance.')
const cases = new Set(matrix.rows.map(row => `${row.harness}:${row.role}:${row.hostKind}`))
for (const harness of ['codex', 'claude']) {
  for (const role of ['operator', 'agent']) for (const host of ['main', 'device']) {
    assert.ok(cases.has(`${harness}:${role}:${host}`), `Missing ${harness}:${role}:${host}`)
  }
}
const evidence = { sdkPins: { codex: pkg.dependencies['@openai/codex'], claude: pkg.dependencies['@anthropic-ai/claude-agent-sdk'] },
  sourceCommit: matrix.sourceCommit, baseUrl: base.origin, rows: [],
  nativeQualification: false }

const httpHeaders = sessionControlHeaders(matrix)
async function request(url, body, options = {}) {
  const response = await fetch(url, { headers: httpHeaders, credentials: 'omit',
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: options.signal ?? AbortSignal.timeout(180000) })
  assert.ok(response.ok, `Application request failed: ${response.status}`)
  return response.json()
}
const product = await sessionControlProduct(matrix)
const transport = sessionControlTransport({ baseUrl: base, tool: product.tool, request })
const read = row => transport.controls(row)
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
  return transport.transcript(row)
}
function messages(value) { return value.state?.messages ?? value.messages }
async function send(row, content, sessionMode) {
  const input = { ...row.sendRequest, requestId: randomUUID(), content,
    ...(sessionMode ? { sessionMode } : {}) }
  const accepted = await transport.send(row, input)
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
  return transport.change(row, { ...input,
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
async function nativeCheckpoint(row, command, requestId, phase) {
  assert.ok(command?.command && Array.isArray(command.args), 'Supply the actual native owner checkpoint command.')
  const result = await promisify(execFile)(command.command, [...command.args, JSON.stringify({
    phase, requestId, conversationId: row.conversationId, nativeHost: row.nativeHost, nativeProfile: row.nativeProfile,
  })], { cwd: command.cwd, timeout: 180000, maxBuffer: 1024 * 1024 })
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.requestId, requestId)
  assert.equal(observed.nativeHost, row.nativeHost)
  assert.equal(observed.nativeProfile, row.nativeProfile)
  return observed
}

async function restartUnsettled(row, scenario) {
  const before = await idle(row)
  const input = { kind: 'compact', requestId: randomUUID(), expectedRevision: before.revision }
  // The checkpoint suspends the actual native owner at its output boundary, using its normal process controls.
  // It reads the native request journal; it does not substitute provider responses or SDK methods.
  await nativeCheckpoint(row, scenario.checkpoint, input.requestId, 'arm')
  const lost = new AbortController()
  const submission = transport.change(row, input, { signal: lost.signal }).catch(error => {
    if (!lost.signal.aborted) throw error
  })
  const native = await nativeCheckpoint(row, scenario.checkpoint, input.requestId, 'dispatched')
  assert.equal(native.dispatchCount, 1)
  assert.equal(native.nativeSessionId, before.nativeSessionId)
  assert.equal(native.terminalObserved, false)
  const admitted = await read(row)
  assert.equal(admitted.compaction?.requestId, input.requestId)
  assert.equal(admitted.compaction.dispatchPhase, 'dispatched')
  assert.ok(['accepted', 'running', 'uncertain'].includes(admitted.compaction.status),
    'The API must still be unsettled when restart begins.')
  lost.abort()
  await submission
  const restarted = await restart(row)
  assert.equal(restarted.compaction?.requestId, input.requestId)
  assert.ok(['accepted', 'running', 'uncertain'].includes(restarted.compaction.status),
    'The new API must observe the outstanding native request before its result is released.')
  await nativeCheckpoint(row, scenario.checkpoint, input.requestId, 'release')
  const recovered = await settled(row, input.requestId)
  assert.equal(recovered.compaction.status, scenario.expectedStatus)
  assert.equal(recovered.nativeSessionId, before.nativeSessionId)
  const observed = await nativeCheckpoint(row, scenario.checkpoint, input.requestId, 'settled')
  assert.equal(observed.dispatchCount, 1, 'Read-only recovery dispatched compaction again.')
  assert.equal(observed.terminalStatus, scenario.expectedStatus)
  const replay = await transport.change(row, input)
  assert.equal(replay.compaction.requestId, input.requestId)
  assert.equal(replay.compactions.filter(compaction => compaction.requestId === input.requestId).length, 1)
  const afterReplay = await nativeCheckpoint(row, scenario.checkpoint, input.requestId, 'settled')
  assert.equal(afterReplay.dispatchCount, 1)
  await send(row, 'Reply briefly without changing files. This is a follow-up after recovered compaction.')
  return { requestId: input.requestId, native, recovered: recovered.compaction, observed, afterReplay }
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
  const checked = await product.tool('harness_instance_check',
    { ...row.profileCheckRequest, commandId: randomUUID() })
  assert.equal(checked.value.instanceId, row.nativeProfile)
  assert.equal(checked.value.target.hostRef.kind, row.hostKind)
  assert.equal(checked.proof.authenticated, true)
  assert.equal(checked.proof.compatible, true)
  assert.equal(checked.proof.qualified, true, 'The actual installed native security/policy check did not qualify.')
  if (row.hostKind === 'device') assert.equal(checked.value.target.hostRef.deviceId, row.nativeHost)
  return checked.proof
}
async function freshControls(row) {
  assert.deepEqual(messages(await transcript(row)), [], 'Each native matrix row must start with a fresh chat.')
  const before = await read(row)
  const plan = await update(row, { kind: 'mode', mode: 'plan' })
  assert.equal(plan.desiredMode, 'plan', 'Fresh bare Plan was not admitted.')
  assert.deepEqual(messages(await transcript(row)), [], 'Fresh bare Plan submitted a model message.')
  const desired = row.harness === 'claude' ? { ...before.desired, autoCompact: 'off' } : before.desired
  const configured = await update(row, { kind: 'preferences', preferences: desired })
  assert.deepEqual(configured.desired, desired, 'Fresh preference admission did not persist.')
  assert.deepEqual(messages(await transcript(row)), [], 'Preference admission submitted a model message.')
  const command = { kind: 'compact', requestId: randomUUID(), expectedRevision: configured.revision }
  const admitted = await transport.change(row, command)
  assert.equal(admitted.compaction?.requestId, command.requestId, 'Fresh compact was not durably admitted.')
  const compacted = await settled(row, command.requestId)
  // An empty provider session may report nothing to compact or a native refusal.
  // The populated-context checks below still require a successful manual boundary.
  assert.ok(['completed', 'no-op', 'failed'].includes(compacted.compaction.status))
  if (compacted.nativeSessionId) {
    assert.equal(compacted.compaction.dispatchPhase, 'dispatched', 'The existing fresh session was not addressed.')
  } else {
    assert.equal(compacted.compaction.status, 'no-op', 'A chat without a session must report that there is nothing to compact.')
    assert.equal(compacted.compaction.dispatchPhase, 'reserved', 'An absent session cannot claim native dispatch.')
    assert.equal(compacted.compaction.nativeOperationId, null)
  }
  assert.deepEqual(messages(await transcript(row)), [], 'Fresh compact changed application message history.')
  const regular = await update(row, { kind: 'mode', mode: 'regular' })
  assert.equal(regular.desiredMode, 'regular')
  assert.deepEqual(messages(await transcript(row)), [], 'Plan off submitted a model message.')
  return { before, plan, configured, compacted, regular }
}
try {
  assert.deepEqual(product.identity, matrix.expectedIdentity, 'The prepared production fixture identity changed.')
  for (const row of matrix.rows) {
    assert.ok(row.nativeHost && row.nativeProfile && row.nativeCliVersion && row.model,
      'Record the measured native host, profile, CLI version and selected model.')
    const nativeProof = await checkedProfile(row)
    const fresh = await freshControls(row)
    assert.ok(Array.isArray(row.compactionInputs) && row.compactionInputs.length, 'Supply native context-building messages.')
    const marker = randomUUID()
    const beforeRun = row.runReadPath ? await request(new URL(row.runReadPath, base)) : null
    const normal = await send(row, `Remember this session marker and repeat it exactly once: ${marker}`)
    if (fresh.compacted.nativeSessionId) {
      assert.equal((await read(row)).nativeSessionId, fresh.compacted.nativeSessionId,
        'The first message replaced the existing fresh native session.')
    }
    for (const content of row.compactionInputs) await send(row, content)
    const before = await idle(row)
    assert.ok(before.nativeSessionId, 'A normal text turn must establish a native session.')
    assert.equal(before.nativeProviderVersion, row.nativeCliVersion, 'The live session differs from the measured native CLI.')
    assert.equal(before.capabilities.model, row.model, 'The native manager differs from the selected model.')
    assert.equal(before.capabilities.compact.supported, true)
    assert.equal(before.capabilities.plan.supported, true)
    const beforeTranscript = messages(await transcript(row))
    const command = { kind: 'compact', requestId: randomUUID(), expectedRevision: before.revision }
    let compacted = await transport.change(row, command)
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
    const replay = await transport.change(row, command)
    assert.equal(replay.compaction.requestId, command.requestId)
    assert.deepEqual(messages(await transcript(row)), beforeTranscript, 'Compaction changed application message history.')
    const turnCount = messages(await transcript(row)).length
    const planned = await transport.change(row, {
      kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: replay.revision,
    })
    assert.equal(planned.desiredMode, 'plan')
    assert.equal(messages(await transcript(row)).length, turnCount, 'Bare Plan created a model message.')
    const task = await send(row, 'Describe a short read-only inspection plan. Do not modify files.', 'plan')
    const duplicate = await transport.send(row, task.input)
    assert.equal(duplicate.replayed, true)
    const afterPlan = await idle(row)
    assert.equal(afterPlan.appliedMode, 'plan', 'The native Plan control was not acknowledged before the task.')
    assert.equal(messages(await transcript(row)).filter(message => message.requestId === task.input.requestId && message.role === 'user').length, 1)
    const exited = await transport.change(row, {
      kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: afterPlan.revision,
    })
    assert.equal(exited.desiredMode, 'regular')
    await send(row, 'Reply with only the session marker from the earlier message.')
    const reply = messages(await transcript(row)).filter(message => message.role === 'assistant').at(-1)
    assert.ok(reply?.content.includes(marker), 'The follow-up did not retain the prior session context.')
    if (beforeRun) assert.deepEqual(await request(new URL(row.runReadPath, base)), beforeRun, 'Chat controls changed the selected Run.')
    let desired = (await idle(row)).desired
    if (row.harness === 'codex') {
      const controls = await read(row)
      if (controls.capabilities.contextBudgets.length) {
        desired = { ...desired, contextBudget: controls.capabilities.contextBudgets[0] }
        const configured = await preferences(row, desired)
        assertCodexContextBudget(controls, configured, desired.contextBudget)
      } else {
        assert.ok(controls.capabilities.modelCapacity > 0, 'Unknown model capacity does not prove a native budget limitation.')
        assert.ok(controls.capabilities.contextBudgetReason, 'Expose the qualified native budget limit explicitly.')
      }
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
    assert.deepEqual((await transport.futureDefaults(row)).desired, desired)
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
      assert.equal(decodeMcpToolResult(parity).nativeSessionId, after.nativeSessionId)
      assert.equal(decodeMcpToolResult(parity).desiredMode, 'regular')
      assert.deepEqual(decodeMcpToolResult(parity).capabilities.contextBudgets, after.capabilities.contextBudgets)
      assert.equal(decodeMcpToolResult(parity).capabilities.contextBudgetReason, after.capabilities.contextBudgetReason)
      const target = { conversationId: row.conversationId, ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}) }
      const write = await client.callTool({ name: `${row.role}_chat_controls_update`, arguments: { ...target,
        request: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: decodeMcpToolResult(parity).revision } } })
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
      assert.ok(Array.isArray(row.restartRecovery) && row.restartRecovery.length,
        'Supply native output checkpoints for restart during unsettled dispatch.')
      const expectedOutcomes = row.harness === 'claude' ? ['completed', 'no-op', 'failed'] : ['completed']
      for (const outcome of expectedOutcomes) {
        assert.ok(row.restartRecovery.some(scenario => scenario.expectedStatus === outcome),
          `Missing unsettled ${row.harness} ${outcome} restart case.`)
      }
      row.recoveryEvidence = []
      for (const scenario of row.restartRecovery) {
        for (const content of scenario.inputs ?? []) await send(row, content)
        row.recoveryEvidence.push(await restartUnsettled(row, scenario))
      }
    } finally { await client.close() }
    const finalNativeProof = await checkedProfile(row)
    assert.deepEqual(finalNativeProof.target, nativeProof.target)
    assert.equal(finalNativeProof.configurationFingerprint, nativeProof.configurationFingerprint)
    evidence.rows.push({ harness: row.harness, role: row.role, host: row.nativeHost, profile: row.nativeProfile,
      freshControls: fresh,
      model: row.model, nativeCliVersion: row.nativeCliVersion, normalRequestId: normal.input.requestId,
      nativeSessionId: after.nativeSessionId, compactRequestId: command.requestId, compactResult: compacted.compaction,
      hostKind: row.hostKind, nativeProof, finalNativeProof, beforeContext: before.context, afterContext: after.context, planTaskRequestId: task.input.requestId,
      restartRecovery: row.recoveryEvidence, appliedMode: after.appliedMode, preferences: { desired: after.desired, applied: after.applied } })
  }
  evidence.nativeQualification = true
  await writeFile(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write('Eight production native control paths, policy checks and restart recovery qualified.\n')
} finally {
  await product.close()
}
