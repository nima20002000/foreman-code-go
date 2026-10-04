import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { it } from 'vitest'
import type { RunSubagent, RunSubagentCommandReceipt } from '@graphql/contracts/subagents'
import { subagentCapabilities } from '@graphql/contracts/subagents'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { productionSubagentControls } from '../src/modules/subagents/productionControls.js'
import { nativeMessageId, object, providerSupports } from '../src/modules/harnesses/opencodeProtocol.js'
import {
  nativeConfigurationFixture, nativeJson, nativePrompt, withNativeUserMessage,
} from './support/opencodeNativeConfiguration.js'

it('reattaches a persisted native fork after an unnamed turn initializes its default metadata', async () => {
  const f = await nativeConfigurationFixture()
  try {
    const { native, server } = f.allocate()
    const source = await native.createSession(f.start())
    assert.equal(source.providerVersion, '1.18.31')
    await nativeJson(server, f.directory, `/session/${source.nativeSessionId}/message`, {
      ...nativePrompt('source-history', 'parent', 'Source task'), agent: 'parent',
    })
    const before = await nativeJson(server, f.directory, `/session/${source.nativeSessionId}`)
    const fork = await native.forkSession(source, f.start())
    // A preexisting native caller omits the variant, producing the persisted default sentinel.
    const result = await nativeJson(server, f.directory, `/session/${fork.nativeSessionId}/message`, {
      ...nativePrompt('fork-default', 'parent', 'Fork task'), agent: 'parent',
    })
    assert.equal(object(result.info).finish, 'stop')
    assert.equal(object(result.info).error, undefined)
    const persisted = await nativeJson(server, f.directory, `/session/${fork.nativeSessionId}`)
    assert.equal(object(persisted.model).variant, 'default')
    assert.deepEqual(await nativeJson(server, f.directory, `/session/${source.nativeSessionId}`), before)
    await native.dispose()

    const restarted = f.allocate()
    assert.deepEqual(await restarted.native.attachSession(fork, f.start()), fork)
    for await (const event of restarted.native.startTurn(fork, {
      prompt: 'Continue the fork', clientCorrelationId: 'fork-after-restart',
    })) void event
    assert.equal((await restarted.native.reconcile(fork, 'fork-after-restart')).terminalResult?.outcome, 'succeeded')
  } finally {
    await f.close()
  }
}, 90_000)

it('keeps the unnamed choice in native user messages despite a custom agent named variant', async () => {
  const f = await nativeConfigurationFixture()
  try {
    const { native, server } = f.allocate()
    const session = await native.createSession(f.start({ ...f.harness, model: 'fixture/child', nativeAgent: 'reviewer' }))
    assert.equal(session.providerVersion, '1.18.31')
    const agents = await server.request(`/agent?directory=${encodeURIComponent(f.directory)}`)
    const reviewer = (await agents.json() as Record<string, unknown>[]).find(agent => agent.name === 'reviewer')!
    assert.equal(reviewer.variant, 'focused')
    const providers = await nativeJson(server, f.directory, '/provider')
    assert.equal(providerSupports(providers, 'fixture', 'child', ''), true)
    assert.equal(providerSupports(providers, 'fixture', 'child', 'focused'), true)
    assert.equal(providerSupports(providers, 'fixture', 'child', 'unadvertised'), false)
    for await (const event of native.startTurn(session, { prompt: 'Use the unnamed variant',
      clientCorrelationId: 'custom-unnamed',
    })) void event
    assert.equal((await native.reconcile(session, 'custom-unnamed')).terminalResult?.outcome, 'succeeded')
    const stored = await nativeJson(server, f.directory,
      `/session/${session.nativeSessionId}/message/${nativeMessageId('custom-unnamed')}`)
    assert.equal(object(stored.info).agent, 'reviewer')
    assert.deepEqual(object(stored.info).model, { providerID: 'fixture', modelID: 'child', variant: '' })
    assert.equal(object((await nativeJson(server, f.directory, `/session/${session.nativeSessionId}`)).model).variant, '')
    assert(f.calls.some(call => call.model === 'child'))
  } finally {
    await f.close()
  }
}, 90_000)

it('preserves a completed child configuration through the production control resolver', async () => {
  assert(process.env.TEST_DATABASE_URL, 'The native child control regression requires TEST_DATABASE_URL.')
  const f = await nativeConfigurationFixture()
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })
  const runId = randomUUID()
  let owner: RunOwnership | undefined
  let managers: ExecutionScopedNativeSessionManagerResolver | undefined
  try {
    owner = await RunOwnership.acquire(pool, runId, () => {})
    assert(owner)
    const { native, server } = f.allocate()
    managers = new ExecutionScopedNativeSessionManagerResolver(() => native)
    const start = f.start()
    const context = { harness: 'opencode' as const, executionId: start.request.executionId, agentId: 'agent-1',
      workingDirectory: f.directory, runId, attempt: 1, configuration: start.request.configuration }
    const resolved = managers.resolve(context, owner)
    resolved.beginStart!()
    const parent = await native.createSession(start)
    assert.equal(parent.providerVersion, '1.18.31')
    resolved.markResident!()
    const parentBefore = await nativeJson(server, f.directory, `/session/${parent.nativeSessionId}`)
    const child = await nativeJson(server, f.directory, '/session', {
      parentID: parent.nativeSessionId, title: 'Configuration child', agent: 'reviewer',
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    })
    const initial = await nativeJson(server, f.directory, `/session/${child.id}/message`, {
      ...nativePrompt('child-initial', 'child', 'Complete the child task'), variant: 'focused', system: 'Child system text',
    })
    assert.equal(object(initial.info).finish, 'stop')
    assert.equal(object(initial.info).error, undefined)
    const childBefore = await nativeJson(server, f.directory, `/session/${child.id}`)
    const record = childRecord(parent.nativeSessionId, String(child.id), runId)
    const controls = productionSubagentControls(managers)
    const lease = controls(record)!
    assert(lease?.sendInput)
    const receipt = childReceipt(record, lease.generation)
    await withNativeUserMessage(server, f.directory, String(child.id), receipt.nativeCorrelationId,
      () => lease.sendInput!(receipt, 'Continue with the child configuration'))

    const stored = await nativeJson(server, f.directory, `/session/${child.id}/message/${receipt.nativeCorrelationId}`)
    assert.equal(object(stored.info).agent, 'reviewer')
    assert.deepEqual(object(stored.info).model, { providerID: 'fixture', modelID: 'child', variant: 'focused' })
    assert.equal(object(stored.info).system, 'Child system text')
    const childAfter = await nativeJson(server, f.directory, `/session/${child.id}`)
    assert.equal(childAfter.agent, childBefore.agent)
    assert.deepEqual(childAfter.model, childBefore.model)
    assert.deepEqual(childAfter.permission, childBefore.permission)
    assert.deepEqual(await nativeJson(server, f.directory, `/session/${parent.nativeSessionId}`), parentBefore)
    assert.equal((await native.history(parent)).nativeTurnId, undefined)
    await assert.rejects(lease.sendInput(receipt, 'Continue with the child configuration'))
    await owner.release()
    assert.equal(lease.matches(record), false)
  } finally {
    try {
      await managers?.dispose()
      await owner?.release()
      await pool.end()
    } finally {
      await f.close()
    }
  }
}, 90_000)

function childRecord(parentSessionId: string, childSessionId: string, runId: string): RunSubagent {
  return { schemaVersion: 1, id: 'child', revision: '1', workspaceId: 'workspace-1', workflowId: 'workflow-1',
    workflowVersionId: 'version-1', runId, parentNodeId: 'node-1', parentAgentId: 'agent-1',
    parentExecutionId: 'execution-1', parentAttemptKey: 'execution-1:1', parentSubagentId: null,
    provider: 'opencode', nativeMode: 'opencode-task', native: { parentSessionId, childSessionId },
    profile: { deviceId: 'main', harnessInstanceId: 'config-opencode', providerVersion: '1.18.31' },
    name: 'Reviewer', status: 'completed', evidence: 'confirmed', firstObservedAt: '2026-10-04T00:00:00.000Z',
    lastObservedAt: '2026-10-04T00:00:00.000Z', startedAt: null, finishedAt: null,
    coverage: { transcript: 'partial', tools: 'partial', gaps: true },
    capabilities: subagentCapabilities('opencode-task', '1.18.31') }
}

function childReceipt(child: RunSubagent, generation: string): RunSubagentCommandReceipt {
  return { schemaVersion: 1, id: randomUUID(), principalId: 'principal', operation: 'run_subagent_input_v1',
    commandId: randomUUID(), workspaceId: child.workspaceId, runId: child.runId, subagentId: child.id,
    expectedRevision: child.revision, nativeGeneration: generation, nativeTurnId: null,
    nativeCorrelationId: nativeMessageId(randomUUID()), state: 'dispatching',
    acceptedAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' }
}
