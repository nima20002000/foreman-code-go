import { describe, expect, it } from 'vitest'
import { subagentCapabilities, type RunSubagent, type RunSubagentCommandReceipt } from '@foreman-code/contracts/subagents'
import { configuration, FixtureServer, manager, sessionFor } from './opencode-fixtures.js'
import { SubagentDispatchRejectedError } from '../src/modules/subagents/controlErrors.js'

// Transport fixtures are not live native qualification evidence.
const child = (parent: string): RunSubagent => ({ schemaVersion: 1, id: 'child', revision: '1', workspaceId: 'workspace-1',
  workflowId: 'workflow-1', workflowVersionId: 'version-1', runId: 'run-1', parentNodeId: 'node-1', parentAgentId: 'agent-1',
  parentExecutionId: 'execution-1', parentAttemptKey: 'execution-1:1', parentSubagentId: null,
  provider: 'opencode', nativeMode: 'opencode-task', native: { parentSessionId: parent, childSessionId: 'ses_child' },
  profile: { deviceId: 'main', harnessInstanceId: 'config-opencode', providerVersion: '1.18.31' }, name: 'Child', status: 'waiting', evidence: 'confirmed',
  firstObservedAt: '2026-10-04T00:00:00.000Z', lastObservedAt: '2026-10-04T00:00:00.000Z', startedAt: null, finishedAt: null,
  coverage: { transcript: 'partial', tools: 'partial', gaps: true }, capabilities: subagentCapabilities('opencode-task', '1.18.31') })
const receipt = (): RunSubagentCommandReceipt => ({ schemaVersion: 1, id: 'receipt', principalId: 'principal', operation: 'run_subagent_input_v1',
  commandId: 'command', workspaceId: 'workspace-1', runId: 'run-1', subagentId: 'child', expectedRevision: '1', nativeGeneration: 'captured',
  nativeTurnId: null, nativeCorrelationId: 'msg_child_command', state: 'dispatching', acceptedAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' })
async function fixture() {
  const server = new FixtureServer(), native = manager(server)
  const session = await sessionFor(native)
  server.addSession('ses_child', session.nativeSessionId, { ...configuration(), nativeAgent: 'plan', variant: '' })
  const prompt = server.user('child-start', 'Child task', 'ses_child')
  prompt.info.agent = 'plan'
  prompt.info.system = 'Child instructions'
  server.assistant(String(prompt.info.id), 'Child complete', 'stop', true, 'ses_child')
  const record = child(session.nativeSessionId)
  return { server, native, session, record }
}

describe('OpenCode exact-parent child control transport', () => {
  it('sends an idle child prompt once with durable correlation without changing the parent turn', async () => {
    const f = await fixture()
    try {
      const lease = f.native.subagentControl(f.record, () => {})!
      expect(lease.nativeTurnId).toBeNull()
      expect(lease.interrupt).toBeUndefined()
      await lease.sendInput!(receipt(), 'Follow up')
      const calls = f.server.calls.filter(call => call.path.includes('prompt_async'))
      expect(calls).toHaveLength(1)
      expect(calls[0]?.path).toContain('/session/ses_child/prompt_async')
      expect(calls[0]?.body).toEqual({ messageID: 'msg_child_command', parts: [{ type: 'text', text: 'Follow up' }],
        agent: 'plan', model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
        variant: '', system: 'Child instructions' })
      await expect(lease.sendInput!(receipt(), 'Follow up')).rejects.toThrow()
      expect(f.server.calls.filter(call => call.path.includes('prompt_async'))).toHaveLength(1)
      expect((await f.native.history(f.session)).nativeTurnId).toBeUndefined()
    } finally { await f.native.dispose() }
  })
  it('retains the child model and named variant across paged history', async () => {
    const f = await fixture()
    try {
      f.server.sessionInfos.get('ses_child')!.model = { providerID: 'child-provider', id: 'child-model', variant: 'high' }
      for (let index = 0; index < 70; index++) {
        f.server.assistant('msg_child_start', 'Child output', 'stop', true, 'ses_child')
      }
      const lease = f.native.subagentControl({ ...f.record, status: 'completed' }, () => {})!
      await lease.sendInput!(receipt(), 'Keep working')
      expect(f.server.calls.find(call => call.path.includes('prompt_async'))?.body).toMatchObject({
        agent: 'plan', model: { providerID: 'child-provider', modelID: 'child-model' },
        variant: 'high', system: 'Child instructions',
      })
      expect(f.server.calls.filter(call => call.path.includes('/ses_child/message?'))).toHaveLength(2)
    } finally { await f.native.dispose() }
  })
  it('normalizes the child session default sentinel without inheriting the parent variant', async () => {
    const f = await fixture()
    try {
      f.server.sessionInfos.get('ses_child')!.model = {
        providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default',
      }
      await f.native.subagentControl(f.record, () => {})!.sendInput!(receipt(), 'Keep working')
      expect(f.server.calls.find(call => call.path.includes('prompt_async'))?.body?.variant).toBe('')
    } finally { await f.native.dispose() }
  })
  it('checks ownership after asynchronous child history reads', async () => {
    const f = await fixture()
    try {
      let owned = true
      const lease = f.native.subagentControl(f.record, () => { if (!owned) throw new Error('owner lost') })!
      f.server.beforeRequest = path => {
        if (path.includes('/ses_child/message?')) owned = false
        return undefined
      }
      await expect(lease.sendInput!(receipt(), 'No')).rejects.toBeInstanceOf(SubagentDispatchRejectedError)
      expect(f.server.calls.filter(call => call.path.includes('prompt_async'))).toHaveLength(0)
    } finally { await f.native.dispose() }
  })
  it('rejects cross-session history before child input dispatch', async () => {
    const f = await fixture()
    try {
      f.server.messages.get('ses_child')![0]!.info.sessionID = f.session.nativeSessionId
      const lease = f.native.subagentControl(f.record, () => {})!
      await expect(lease.sendInput!(receipt(), 'No')).rejects.toBeInstanceOf(SubagentDispatchRejectedError)
      expect(f.server.calls.filter(call => call.path.includes('prompt_async'))).toHaveLength(0)
    } finally { await f.native.dispose() }
  })
  it('fences a stale generation and changed native ancestry before mutation', async () => {
    const f = await fixture()
    try {
      const lease = f.native.subagentControl(f.record, () => {})!
      f.server.sessionInfos.set('ses_child', { id: 'ses_child', parentID: 'unrelated', directory: '/workspace/project' })
      await expect(lease.sendInput!(receipt(), 'No')).rejects.toThrow()
      f.server.generation++
      expect(lease.matches(f.record)).toBe(false)
      expect(() => lease.assertCurrent()).toThrow()
      expect(f.server.calls.filter(call => call.path.includes('prompt_async'))).toHaveLength(0)
    } finally { await f.native.dispose() }
  })
  it('checks owner loss after asynchronous native reads and rejects active children', async () => {
    const f = await fixture()
    try {
      let owned = true
      const lease = f.native.subagentControl(f.record, () => { if (!owned) throw new Error('owner lost') })!
      f.server.beforeRequest = path => { if (path.startsWith('/session/status')) owned = false; return undefined }
      await expect(lease.sendInput!(receipt(), 'No')).rejects.toBeInstanceOf(SubagentDispatchRejectedError)
      owned = true; f.server.beforeRequest = undefined
      f.server.statuses.set('ses_child', { type: 'busy' })
      await expect(lease.sendInput!(receipt(), 'No')).rejects.toThrow()
      expect(f.native.subagentControl({ ...f.record, status: 'running' }, () => {})?.sendInput).toBeUndefined()
      expect(f.server.calls.filter(call => call.path.includes('prompt_async'))).toHaveLength(0)
    } finally { await f.native.dispose() }
  })
  it('walks the exact nested ancestry and rejects wrong receipt identity', async () => {
    const f = await fixture()
    try {
      f.server.sessionInfos.set('ses_parent', { id: 'ses_parent', parentID: f.session.nativeSessionId, directory: '/workspace/project' })
      f.server.sessionInfos.set('ses_child', { id: 'ses_child', parentID: 'ses_parent', directory: '/workspace/project' })
      const lease = f.native.subagentControl({ ...f.record, parentSubagentId: 'parent', native: { parentSessionId: 'ses_parent', childSessionId: 'ses_child' } }, () => {})!
      await expect(lease.sendInput!({ ...receipt(), runId: 'different' }, 'No')).rejects.toThrow()
      await lease.sendInput!(receipt(), 'Nested follow up')
      expect(f.server.calls.filter(call => call.path.includes('prompt_async'))).toHaveLength(1)
    } finally { await f.native.dispose() }
  })
  it('reconciles a lost acknowledgement from the exact active child message without replay', async () => {
    const f = await fixture()
    try {
      f.server.onPrompt = async () => { throw new Error('lost native ACK') }
      const lease = f.native.subagentControl(f.record, () => {})!
      await expect(lease.sendInput!(receipt(), 'One prompt')).rejects.toThrow()
      const active = f.native.subagentControl({ ...f.record, status: 'running',
        native: { ...f.record.native, currentTurnId: receipt().nativeCorrelationId } }, () => {})!
      expect(active.sendInput).toBeUndefined()
      expect(await active.reconcile!(receipt())).toBe('acknowledged')
      expect(f.server.calls.filter(call => call.path.includes('prompt_async'))).toHaveLength(1)
      expect(await active.reconcile!({ ...receipt(), nativeCorrelationId: 'msg_absent' })).toBe('uncertain')
    } finally { await f.native.dispose() }
  })
})
