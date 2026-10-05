import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeSessionReference } from '@graphql/contracts'
import type { WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import type { RunSubagent } from '@graphql/contracts/subagents'
import { describe, expect, it, vi } from 'vitest'
import { CodexChildControls } from '../src/modules/harnesses/codexChildControls.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { SubagentDispatchRejectedError } from '../src/modules/subagents/controlErrors.js'
import { childControlRecord, childControlReceipt, codexChildControlFixture } from './fixtures/codex-child-control-helpers.js'
import { calls, fixture, fixtureQualification, input, nativeThread, state, until } from './fixtures/codex-test-helpers.js'

vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>(
    '../src/modules/harnesses/codexProtocol.js',
  )
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
vi.doMock('../src/modules/harnesses/codexStdioTransport.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexStdioTransport.js')>(
    '../src/modules/harnesses/codexStdioTransport.js',
  )
  class TestTransport extends actual.CodexStdioTransport {
    constructor(...args: ConstructorParameters<typeof actual.CodexStdioTransport>) {
      args[7] = 500
      super(...args)
    }
  }
  return { ...actual, CodexStdioTransport: TestTransport }
})
const { CodexAppServerSessionManager } = await import('../src/modules/harnesses/codexAppServer.js')

describe('Codex child controls through the pinned protocol', () => {
  it.each(['codex-collab', 'codex-multi-agent-v2'] as const)('steers the owned %s child turn and preserves native correlation', async nativeMode => {
    const child = childControlRecord({ nativeMode })
    const f = codexChildControlFixture(child)
    const lease = f.lease()
    expect(lease.capabilities).toMatchObject({ sendInput: { support: 'supported', qualification: 'passed' },
      interrupt: { support: 'supported', qualification: 'passed' } })
    await lease.sendInput!(childControlReceipt(child), 'Follow up')
    expect(f.calls.filter(call => call.method.startsWith('turn/'))).toEqual([{ method: 'turn/steer', params: {
      threadId: 'native-child', expectedTurnId: 'child-turn', clientUserMessageId: 'app-correlation',
      input: [{ type: 'text', text: 'Follow up', text_elements: [] }],
    } }])
    expect(f.threads.get('native-child')!.turns[0]!.items[0]).toMatchObject({
      type: 'userMessage', clientId: 'app-correlation',
    })
  })
  it('resumes and continues an idle child without copying parent configuration', async () => {
    const child = childControlRecord({ status: 'completed' })
    const f = codexChildControlFixture(child)
    await f.lease().sendInput!(childControlReceipt(child, { nativeTurnId: null }), 'Continue')
    expect(f.calls.find(call => call.method === 'thread/resume')!.params).toEqual({
      threadId: 'native-child', excludeTurns: true,
    })
    expect(f.calls.find(call => call.method === 'turn/start')!.params).toEqual({
      threadId: 'native-child', clientUserMessageId: 'app-correlation',
      input: [{ type: 'text', text: 'Continue', text_elements: [] }],
    })
    expect(f.calls.some(call => call.params.threadId === 'root')).toBe(false)
  })
  it('qualifies each operation independently instead of blocking the whole provider', () => {
    const f = codexChildControlFixture()
    const protocol = f.host.qualified.protocol
    f.host.qualified.protocol = { ...protocol, request: request => {
      if (request.method === 'turn/steer') throw new HarnessExecutionError('CODEX_METHOD_UNQUALIFIED', 'Method absent')
      protocol.request(request)
    } }
    const lease = f.lease()
    expect(lease.sendInput).toBeUndefined()
    expect(lease.interrupt).toBeDefined()
    expect(lease.capabilities).toMatchObject({ sendInput: { qualification: 'unverified' },
      interrupt: { support: 'supported', qualification: 'passed' } })
  })
  it('interrupts only the captured child turn and recovers a lost ACK through native status', async () => {
    const f = codexChildControlFixture()
    const receipt = childControlReceipt(undefined, { operation: 'run_subagent_interrupt_v1' })
    f.failOnce('turn/interrupt')
    await expect(f.lease().interrupt!(receipt)).rejects.toMatchObject({ uncertain: true })
    const recovered = new CodexChildControls().lease(childControlRecord(), f.host, f.host.assertCurrent)!
    expect(await recovered.reconcile!(receipt)).toBe('acknowledged')
    expect(f.calls.filter(call => call.method === 'turn/interrupt')).toEqual([{ method: 'turn/interrupt',
      params: { threadId: 'native-child', turnId: 'child-turn' } }])
  })
  it.each(['running', 'completed'] as const)('recovers %s child input after controller restart without resending', async status => {
    const child = childControlRecord({ status })
    const f = codexChildControlFixture(child)
    const receipt = childControlReceipt(child, { nativeTurnId: status === 'running' ? 'child-turn' : null })
    f.failOnce(status === 'running' ? 'turn/steer' : 'turn/start')
    await expect(f.lease().sendInput!(receipt, 'Follow up')).rejects.toMatchObject({ uncertain: true })
    const recovered = new CodexChildControls().lease(child, f.host, f.host.assertCurrent)!
    expect(await recovered.reconcile!(receipt)).toBe('acknowledged')
    expect(await recovered.reconcile!({ ...receipt, nativeCorrelationId: 'foreign-correlation' })).toBe('uncertain')
    if (status === 'running') expect(await recovered.reconcile!({ ...receipt, nativeTurnId: 'foreign-turn' }))
      .toBe('uncertain')
    const item = f.threads.get('native-child')!.turns.at(-1)!.items[0]!
    expect(item.id).not.toBe(receipt.nativeCorrelationId)
    expect(f.calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method))).toHaveLength(1)
  })
  it('checks every ancestor, owner, receipt identity and active turn before a child write', async () => {
    const child = childControlRecord({ native: {
      childSessionId: 'native-child', parentSessionId: 'nested-parent', currentTurnId: 'child-turn',
    } })
    const f = codexChildControlFixture(child)
    f.threads.get('nested-parent')!.parentThreadId = 'foreign-root'
    await expect(f.lease().sendInput!(childControlReceipt(child), 'Input')).rejects.toBeInstanceOf(SubagentDispatchRejectedError)
    expect(f.calls.some(call => call.method === 'turn/steer')).toBe(false)
    const live = codexChildControlFixture()
    const lease = live.lease()
    await expect(lease.sendInput!(childControlReceipt(undefined, { runId: 'foreign-run' }), 'Input'))
      .rejects.toBeInstanceOf(SubagentDispatchRejectedError)
    live.threads.get('native-child')!.turns[0]!.id = 'replacement-turn'
    await expect(lease.interrupt!(childControlReceipt(undefined, { operation: 'run_subagent_interrupt_v1' })))
      .rejects.toBeInstanceOf(SubagentDispatchRejectedError)
    live.loseOwner()
    expect(lease.matches(childControlRecord())).toBe(false)
    await expect(lease.sendInput!(childControlReceipt(), 'Input')).rejects.toThrow('Owner lost')
    expect(live.calls.some(call => call.method.startsWith('turn/'))).toBe(false)
  })
})

async function seedChild(directory: string, root: NativeSessionReference, source: WorkflowNativeSessionStart,
  overrides: Partial<RunSubagent> = {}) {
  const child = childControlRecord({ workspaceId: source.request.workspaceId,
    runId: source.request.runId, parentExecutionId: source.request.executionId,
    parentAttemptKey: `${source.request.executionId}:1`, parentNodeId: source.request.workflowNodeId,
    parentAgentId: source.request.configuration.agentId,
    native: { parentSessionId: root.nativeSessionId, childSessionId: 'native-child', currentTurnId: 'child-turn' },
    profile: { deviceId: 'device', harnessInstanceId: source.request.configuration.id, providerVersion: root.providerVersion },
    ...overrides,
  })
  const active = child.status === 'running'
  const nativeChild = nativeThread({ id: 'native-child', sessionId: 'native-child',
    parentThreadId: root.nativeSessionId, cwd: directory,
    source: { subAgent: { thread_spawn: { parent_thread_id: root.nativeSessionId, depth: 1,
      agent_path: null, agent_nickname: null, agent_role: null } } },
    status: active ? { type: 'active', activeFlags: [] } : { type: 'notLoaded' },
    turns: [{ id: 'child-turn', status: active ? 'inProgress' : 'completed',
      items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: active ? null : 2, durationMs: null }],
  })
  await writeFile(join(directory, 'state-native-child.json'), JSON.stringify({ ...nativeChild,
    settings: { model: 'child-model', modelProvider: 'openai', serviceTier: null, cwd: directory,
      reasoningEffort: 'medium', instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false } },
  }))
  return child
}

describe('Codex session manager child control wiring over stdio', () => {
  it('queues a child command behind the actual parent lifecycle lock without marking it uncertain', async () => {
    const f = await fixture()
    const manager = new CodexAppServerSessionManager(f.binary)
    try {
      const source = input(f.directory)
      const root = await manager.createSession(source)
      const child = await seedChild(f.directory, root, source)
      await writeFile(join(f.directory, 'read-delay'), '')
      const attaching = manager.attachSession(root, source)
      await until(async () => (await calls(f.directory)).some(entry => {
        const wire = entry.wire as { method?: string } | undefined
        return wire?.method === 'thread/read'
      }))
      const lease = manager.subagentControl(child, () => {})!
      const receipt = childControlReceipt(child, { nativeGeneration: lease.generation })
      await lease.sendInput!(receipt, 'Follow up')
      await attaching
      expect(await lease.reconcile!(receipt)).toBe('acknowledged')
      const commands = (await calls(f.directory)).filter(entry =>
        (entry.wire as { method?: string } | undefined)?.method === 'turn/steer')
      expect(commands).toHaveLength(1)
      expect((await state(f.directory, 'native-child')).turns[0]!.items).toMatchObject([
        { type: 'userMessage', clientId: receipt.nativeCorrelationId },
      ])
    } finally {
      await manager.dispose()
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  it.each(['codex-collab', 'codex-multi-agent-v2'] as const)('controls and reconciles the admitted %s child without a parent command', async nativeMode => {
    const f = await fixture()
    const manager = new CodexAppServerSessionManager(f.binary)
    try {
      const source = input(f.directory)
      const root = await manager.createSession(source)
      const child = await seedChild(f.directory, root, source, { nativeMode })
      expect(manager.subagentControl({ ...child, parentExecutionId: 'foreign-execution' }, () => {})).toBeUndefined()
      const lease = manager.subagentControl(child, () => {})!
      const receipt = childControlReceipt(child, { nativeGeneration: lease.generation })
      await lease.sendInput!(receipt, 'Follow up')
      const uncertain = childControlReceipt(child, { id: 'lost-receipt', commandId: 'lost-command',
        nativeCorrelationId: 'lost-application-correlation', nativeGeneration: lease.generation })
      await expect(lease.sendInput!(uncertain, 'lost-steer')).rejects.toMatchObject({ uncertain: true })
      expect(await manager.subagentControl(child, () => {})!.reconcile!(uncertain)).toBe('acknowledged')
      await lease.interrupt!(childControlReceipt(child, { id: 'interrupt-receipt', nativeGeneration: lease.generation,
        operation: 'run_subagent_interrupt_v1' }))
      expect((await state(f.directory, root.nativeSessionId)).turns).toHaveLength(0)
      const childState = await state(f.directory, 'native-child')
      expect(childState.turns[0]).toMatchObject({ status: 'interrupted' })
      const items = childState.turns[0]!.items as { type: string; clientId?: string }[]
      expect(items.filter(item => item.type === 'userMessage').map(item => item.clientId))
        .toEqual(['app-correlation', 'lost-application-correlation'])
      const commands = (await calls(f.directory)).flatMap(entry => {
        const wire = entry.wire as { method?: string; params?: { threadId?: string } } | undefined
        return wire && ['turn/steer', 'turn/start', 'turn/interrupt'].includes(wire.method ?? '') ? [wire] : []
      })
      expect(commands).toHaveLength(3)
      expect(commands.every(command => command.params?.threadId === 'native-child')).toBe(true)
      await manager.close(root)
      expect(lease.matches(child)).toBe(false)
      expect(manager.subagentControl(child, () => {})).toBeUndefined()
    } finally {
      await manager.dispose()
      await rm(f.directory, { recursive: true, force: true })
    }
  })
  it('continues an unloaded idle child with its own settings over the manager transport', async () => {
    const f = await fixture()
    const manager = new CodexAppServerSessionManager(f.binary)
    try {
      const source = input(f.directory)
      const root = await manager.createSession(source)
      const child = await seedChild(f.directory, root, source, { status: 'completed' })
      const lease = manager.subagentControl(child, () => {})!
      await lease.sendInput!(childControlReceipt(child, { nativeTurnId: null, nativeGeneration: lease.generation }), 'wait')
      expect((await state(f.directory, root.nativeSessionId)).turns).toHaveLength(0)
      const native = await state(f.directory, 'native-child')
      expect(native.settings).toMatchObject({ model: 'child-model', approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false } })
      expect(native.turns).toHaveLength(2)
      const requests = (await calls(f.directory)).flatMap(entry => entry.wire ? [entry.wire as {
        method: string; params: Record<string, unknown>,
      }] : [])
      expect(requests.find(request => request.method === 'thread/resume')!.params).toEqual({
        threadId: 'native-child', excludeTurns: true,
      })
      expect(requests.find(request => request.method === 'turn/start')!.params).toMatchObject({
        threadId: 'native-child', clientUserMessageId: 'app-correlation',
      })
    } finally {
      await manager.dispose()
      await rm(f.directory, { recursive: true, force: true })
    }
  })

})
