import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as contracts from '@foreman-code/contracts'
import * as agentChat from '@foreman-code/contracts/agent-chat'
import * as management from '@foreman-code/contracts/management'
import * as profiles from '@foreman-code/contracts/harness-registry'
import * as placements from '@foreman-code/contracts/node-placement'
import * as workflows from '@foreman-code/contracts/wave25'
import * as roots from '@foreman-code/contracts/workspace-root-policies'
import * as boundLocations from '@foreman-code/contracts/workspace-bound-location'
import { pairedWorkerApplication } from './helpers/pairedWorkerApplication.js'

type Row = { harness: 'codex' | 'opencode' | 'claude'; role: 'operator' | 'agent'; hostKind: 'main' | 'device';
  conversationId: string; workspaceId?: string; readPath?: string; sendPath: string;
  sendRequest: Record<string, unknown>; nativeProfile: string; profileCheckRequest: Record<string, unknown> }

const combinations = (['codex', 'opencode', 'claude'] as const).flatMap(harness =>
  (['operator', 'agent'] as const).flatMap(role =>
    (['main', 'device'] as const).map(hostKind => ({ harness, role, hostKind }))))
let fixture: Awaited<ReturnType<typeof pairedWorkerApplication>> | undefined
let rows: Row[] = []
const completed = new Map<string, { marker: string; compactRequest: contracts.SessionControlRequest }>()

function active() {
  if (!fixture) throw new Error('The production fixture has not started.')
  return fixture
}

async function controls(row: Row) {
  const f = active()
  const value = row.role === 'operator'
    ? await f.tool('operator_chat_controls_get', { conversationId: row.conversationId })
    : await f.request(`/api/workspaces/${row.workspaceId}/agent-chat/conversations/${row.conversationId}/session-controls`)
  return contracts.SessionControlStateSchema.parse(value)
}

async function change(row: Row, input: contracts.SessionControlRequest) {
  const f = active()
  const value = row.role === 'operator'
    ? await f.tool('operator_chat_controls_update', { conversationId: row.conversationId, request: input })
    : await f.request(`/api/workspaces/${row.workspaceId}/agent-chat/conversations/${row.conversationId}/session-controls`, input)
  return contracts.SessionControlStateSchema.parse(value)
}

async function idle(row: Row) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const state = await controls(row)
    if (!state.busyReason) return state
    await delay(250)
  }
  throw new Error('Timed out waiting for the real native conversation to become idle.')
}

async function send(row: Row, content: string, mode: 'regular' | 'plan' = 'regular') {
  const f = active()
  const input = { ...row.sendRequest, requestId: randomUUID(), content, sessionMode: mode }
  if (row.role === 'operator') await f.tool('operator_chat_send', { conversationId: row.conversationId, request: input })
  else await f.request(row.sendPath, input)
  return { input, state: await idle(row) }
}

async function transcript(row: Row) {
  const f = active()
  if (row.role === 'operator') {
    return contracts.OperatorConversationStateSchema.parse(await f.tool('operator_chat_get', {
      conversationId: row.conversationId })).messages
  }
  if (!row.readPath) throw new Error('The saved node transcript path is missing.')
  return agentChat.AgentChatStateSchema.parse(await f.request(row.readPath)).messages
}

describe('native session controls through the production Main and installed Worker', () => {
  beforeAll(async () => {
    fixture = await pairedWorkerApplication()
    const f = fixture
    const module = await import(new URL('../../../scripts/acceptance/provision-session-controls.mjs', import.meta.url).href)
    const subjects = (['codex', 'opencode', 'claude'] as const).flatMap(harness =>
      (['main', 'device'] as const).map(hostKind => {
        const hostRef = hostKind === 'main' ? { kind: 'main' as const, mainId: f.identity.installationId } : f.hostRef
        const configuration = harness === 'claude' ? { harness, model: 'claude-haiku-4-5-20251001',
          authMode: 'subscription', configDirectory: hostKind === 'main' ? f.mainProfile : f.workerProfile,
          permissionMode: 'default', sandbox: 'read-only', tools: ['mcp__foreman-code__workspace_list'],
          permissionRules: [], instructions: '', mcpServers: { 'foreman-code': { type: 'http', url: `${f.baseUrl}/mcp` } } }
          : structuredClone(contracts.DEFAULT_HARNESS_DEFAULTS[harness])
        if (configuration.harness === 'codex') {
          configuration.model = process.env.CODEX_MODEL ?? 'gpt-5.6-luna'
          configuration.reasoningEffort = 'medium'
        }
        if (configuration.harness === 'opencode' && process.env.ENG03_A_OPENCODE_MODEL) {
          configuration.model = process.env.ENG03_A_OPENCODE_MODEL
        }
        return { hostRef, configuration, parentPath: f.mainProjects,
          ...(hostKind === 'device' ? { rootSelection: { hostRef, allowedBaseId: f.roots.bases[0]!.baseId,
            configurationRevision: f.roots.configurationRevision, relativePath: '', accessMode: 'read-only' } } : {}) }
      }))
    const prepared: unknown = await module.provisionSessionControlMatrix({ subjects, expectedIdentity: f.identity,
      baseUrl: f.baseUrl, browserOrigin: f.browserOrigin, sourceCommit: f.sourceCommit }, {
      contracts, agentChat, management, profiles, placements, workflows, roots, boundLocations,
      identity: f.identity, tool: f.tool, read: f.request,
    })
    const matrix = prepared as { rows: Row[] }
    expect(matrix.rows).toHaveLength(12)
    rows = matrix.rows
    expect(new Set(rows.map(row => row.conversationId)).size).toBe(12)
  }, 1800000)

  afterAll(async () => { await fixture?.close() }, 180000)

  it.each(combinations)('$harness $role on $hostKind compacts its existing native session and plans one task', async key => {
    const row = rows.find(value => value.harness === key.harness && value.role === key.role && value.hostKind === key.hostKind)
    if (!row) throw new Error('The native matrix row is missing.')
    const before = await controls(row)
    const plan = await change(row, { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: before.revision })
    expect(plan.desiredMode).toBe('plan')
    expect(await transcript(row)).toEqual([])
    await change(row, { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: plan.revision })
    if (row.harness === 'claude') {
      const state = await controls(row)
      await change(row, { kind: 'preferences', requestId: randomUUID(), expectedRevision: state.revision,
        preferences: { ...state.desired, autoCompact: 'off', autoCompactTokens: 100000 } })
    }
    const marker = randomUUID()
    const context = Array.from({ length: 950 }, (_, index) => `context-${index} selected-${index % 97}`).join(' ')
    const normal = await send(row, `Remember marker ${marker}. Read this context and reply only with the marker.\n${context}`)
    const sessionId = normal.state.nativeSessionId
    expect(sessionId).toBeTruthy()
    expect(normal.state.capabilities.compact.supported).toBe(true)
    const beforeMessages = await transcript(row)
    const request = { kind: 'compact' as const, requestId: randomUUID(), expectedRevision: normal.state.revision }
    await change(row, request)
    const deadline = Date.now() + 180000
    let compacted = await controls(row)
    while (Date.now() < deadline && compacted.compaction && ['accepted', 'running', 'uncertain'].includes(compacted.compaction.status)) {
      await delay(250)
      compacted = await controls(row)
    }
    if (compacted.compaction && ['accepted', 'running', 'uncertain'].includes(compacted.compaction.status)) {
      throw new Error('Timed out waiting for real native compaction to settle.')
    }
    expect(compacted.compaction?.status).toBe('completed')
    expect(compacted.nativeSessionId).toBe(sessionId)
    expect(await transcript(row)).toEqual(beforeMessages)
    expect((await change(row, request)).compaction?.requestId).toBe(request.requestId)
    const task = await send(row, 'Describe a read-only inspection plan in one sentence. Do not modify files.', 'plan')
    expect(task.state.appliedMode).toBe('plan')
    expect(task.state.nativeSessionId).toBe(sessionId)
    const denied = await active().deniedTool(`${row.role}_chat_controls_update`, {
      conversationId: row.conversationId, ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      request: { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: task.state.revision } })
    expect(denied.isError).toBe(true)
    expect((await controls(row)).desiredMode).toBe('plan')
    await change(row, { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: task.state.revision })
    const followup = await send(row, 'Reply only with the remembered marker.')
    expect(followup.state.appliedMode).toBe('regular')
    expect(followup.state.nativeSessionId).toBe(sessionId)
    expect((await transcript(row)).filter(message => message.role === 'assistant').at(-1)?.content).toContain(marker)
    completed.set(row.conversationId, { marker, compactRequest: request })
  }, 600000)

  it('restores the twelve native chats and compact receipts after Main closes and starts again', async () => {
    expect(completed.size).toBe(12)
    const snapshots = new Map<string, { state: contracts.SessionControlState; messages: Awaited<ReturnType<typeof transcript>> }>()
    for (const row of rows) {
      snapshots.set(row.conversationId, { state: await idle(row), messages: await transcript(row) })
    }
    await active().restartMain()
    const checkedProfiles = new Set<string>()
    for (const row of rows) {
      if (!checkedProfiles.has(row.nativeProfile)) {
        const checked = profiles.HostHarnessInstanceCheckResultSchema.parse(await active().tool('harness_instance_check', {
          ...row.profileCheckRequest, commandId: randomUUID(),
        }))
        expect(checked.value.instanceId).toBe(row.nativeProfile)
        expect(checked.proof.qualified).toBe(true)
        checkedProfiles.add(row.nativeProfile)
      }
      const before = snapshots.get(row.conversationId)!
      const recovered = await controls(row)
      expect(recovered.nativeSessionId).toBe(before.state.nativeSessionId)
      expect(recovered.desired).toEqual(before.state.desired)
      expect(recovered.desiredMode).toBe('regular')
      expect(recovered.compactions).toEqual(before.state.compactions)
      expect(await transcript(row)).toEqual(before.messages)
      const accepted = completed.get(row.conversationId)!
      const replay = await change(row, accepted.compactRequest)
      expect(replay.compactions).toEqual(before.state.compactions)
      const followup = await send(row, 'Reply only with the remembered marker.')
      expect(followup.state.nativeSessionId).toBe(before.state.nativeSessionId)
      expect(followup.state.appliedMode).toBe('regular')
      expect(followup.state.applied).toEqual(before.state.desired)
      expect((await transcript(row)).filter(message => message.role === 'assistant').at(-1)?.content)
        .toContain(accepted.marker)
    }
  }, 1800000)
})
