import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfigurationVersion, ExecutionResult, HarnessExecution, NativeHarnessEvent, NativeSessionReference, WorkflowRun, WorkflowVersion } from '@graphql/contracts'
import { MemorySaver } from '@langchain/langgraph'
import { describe, it } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { nativeLanes } from './helpers/nativeLanes.js'

const secret = 'private-pr11-engine-secret'
const now = '2026-09-17T00:00:00.000Z'
type Fixture = Awaited<ReturnType<typeof createFixture>>
async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-native-credential-'))
  const configuration: AgentConfigurationVersion = {
    id: 'config-1', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
    prompt: { system: 'Test' }, assignedSkills: [],
    // Explicit native handling: no inferred authority and no routed reviewer.
    harness: { harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max', nativeAgent: 'build', thinking: false, autoApprove: true },
    contentHash: 'sha256:fixture', createdAt: now,
  }
  const run = {
    id: 'run-1', workspaceId: 'workspace-1', workflowId: 'workflow-1', workflowVersionId: 'version-1',
    agentConfigurationVersionIds: { 'agent-1': 'config-1' }, authorizationPrincipalId: 'operator-1',
    executionLocation: { runnerId: 'runner-local', rootPath: directory }, input: {},
    executionState: 'running', outcome: 'pending',
  } as unknown as WorkflowRun
  const version = { definition: { nodes: [{ id: 'node-1', agentId: 'agent-1', initialPrompt: 'Test' }] } } as unknown as WorkflowVersion
  const rows = new Map<string, HarnessExecution>()
  const accepted: HarnessExecution[] = [], events: unknown[] = [], activities: unknown[] = [], revoked: string[] = []
  let changedDirectory = false, revokedAuthority = false, cleanupFails = false
  let prepared: () => Promise<void> = async () => undefined
  let expiresIn = 60_000, creates = 0, starts = 0, cancels = 0
  let native: (signal: AbortSignal) => Promise<ExecutionResult> = async () => ({ outcome: 'succeeded', output: { text: `done ${secret}` } })
  let terminal: ExecutionResult | undefined, correlation: string | undefined
  const session: NativeSessionReference = { harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'native-exact' }
  const manager: NativeHarnessSessionManager = {
    harness: 'opencode',
    capabilities: async () => ({ provider: 'opencode', providerVersion: '1.18.31', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true, supportedInteractionKinds: ['approval'] }),
    inspectMcp: async () => { throw new Error('Not part of this fixture') },
    createSession: async (input: NativeSessionStart) => {
      assert.equal(input.environment?.variables.GRAPHQL_APP_MCP_TOKEN, secret)
      creates += 1
      return session
    },
    attachSession: async (reference: NativeSessionReference) => reference,
    async *startTurn(_session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
      void _session
      assert.ok(signal)
      starts += 1
      correlation = input.clientCorrelationId
      yield { sequence: 0, type: 'proof', occurredAt: now, payload: { unrelated: secret } }
      terminal = await native(signal)
      yield { sequence: 1, type: 'turn.completed', occurredAt: now, payload: {} }
    },
    pending: async () => undefined,
    respond: async () => { throw new Error('Non-routed native work cannot receive a GraphQL decision') },
    cancel: async () => { cancels += 1; return true },
    history: async (): Promise<NativeHistory> => ({ events: [], pendingInteractions: [], ...(terminal ? { terminalResult: terminal } : {}) }),
    reconcile: async (_session: NativeSessionReference, id: string): Promise<NativeHistory> => {
      void _session
      return { events: [], pendingInteractions: [], ...(terminal && id === correlation
        ? { terminalResult: terminal, terminalTurn: { correlationId: id, providerId: 'turn-exact', result: terminal } } : {}) }
    },
    close: async () => undefined,
  }
  const runs = {
    get: async () => run, getExecution: async (id: string) => rows.get(id),
    ensureExecution: async (value: HarnessExecution) => {
      const previous = [...rows.values()].find((row) => row.workflowNodeId === value.workflowNodeId && row.attempt === value.attempt)
      if (!previous) rows.set(value.id, value)
      return { execution: previous ?? value, created: !previous }
    },
    updateExecution: async (value: HarnessExecution) => { rows.set(value.id, value) },
    acceptExecutionResult: async (value: HarnessExecution) => { accepted.push(value) },
    appendNativeEvent: async (value: unknown) => { events.push(value) },
    recordActivity: async (...args: unknown[]) => { activities.push(args) },
    listExecutions: async () => [...rows.values()],
    acquireOwnership: async () => undefined,
  }
  const credentials: ExecutionCredentialProvider = {
    prepare: async () => {
      await prepared()
      return { credential: { principalId: 'worker-1', environment: { agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: secret } },
        expiresAt: new Date(Date.now() + expiresIn).toISOString() }, detection: {} as never }
    },
    revoke: async () => undefined,
    revokeForExecution: async (id) => { revoked.push(id); if (cleanupFails) throw new Error('database unavailable'); return 1 },
    revokeForRun: async (id) => { revoked.push(id); return 1 },
    reconcileTerminalCredentials: async () => undefined,
  }
  const locations = {
    revalidateRunAuthorization: async () => { if (revokedAuthority) throw new DomainError('AUTH_REVOKED', 'revoked', 401) },
    revalidateSnapshot: async () => { if (changedDirectory) throw new DomainError('WORKSPACE_LOCATION_CHANGED', 'changed', 409) },
  }
  const interactions = { coordination: nativeLanes(), getForExecution: async () => undefined, cancelPendingForExecution: async () => undefined,
    cancelPendingForRun: async () => undefined }
  const budgets = { ensure: async () => undefined, remaining: async () => 300_000, assertActive: async () => undefined,
    finish: async () => undefined, stop: async () => undefined }
  const coordinator = new ApprovalExecutionCoordinator(runs as never, interactions as never, budgets as never,
    { resolve: () => ({ manager, processState: 'needs_start' }) }, 300_000, credentials,
    async () => { await locations.revalidateRunAuthorization(); await locations.revalidateSnapshot() })
  const engine = new LangGraphWorkflowEngine(runs as never, { getAgentConfiguration: async () => configuration } as never,
    coordinator, new MemorySaver(), join(directory, 'runtime'), locations as never, credentials, interactions as never)
  const owner = { assertOwned: () => undefined, client: {} }
  return {
    engine, coordinator, credentials, rows, accepted, events, activities, revoked,
    setDirectoryChanged: () => { changedDirectory = true }, setAuthorityRevoked: () => { revokedAuthority = true },
    failCleanup: () => { cleanupFails = true }, onPrepare: (callback: () => Promise<void>) => { prepared = callback },
    setNative: (callback: (signal: AbortSignal) => Promise<ExecutionResult>) => { native = callback },
    setExpiresIn: (ms: number) => { expiresIn = ms }, counters: () => ({ creates, starts, cancels }),
    execute: () => (engine as unknown as { executeNode(...args: unknown[]): Promise<unknown> }).executeNode(
      run, version, 'node-1', [], { runId: run.id, executionIds: {} }, new AbortController().signal, owner),
    async close() { cleanupFails = false; await coordinator.cancelRun(run.id); await rm(directory, { recursive: true, force: true }) },
  }
}
async function withFixture(perform: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture()
  try { await perform(fixture) } finally { await fixture.close() }
}

describe('native launch, outcome and credential lifecycle', () => {
  it('rechecks directory identity after asynchronous credential preparation', async () => {
    await withFixture(async (f) => {
      f.onPrepare(async () => f.setDirectoryChanged())
      await assert.rejects(f.execute(), { code: 'WORKSPACE_LOCATION_CHANGED' })
      assert.equal(f.counters().creates, 0)
      assert.equal(f.revoked.length, 1)
    })
  })
  it('rechecks launch authority after asynchronous credential preparation', async () => {
    await withFixture(async (f) => {
      f.onPrepare(async () => f.setAuthorityRevoked())
      await assert.rejects(f.execute(), { code: 'AUTH_REVOKED' })
      assert.equal(f.counters().creates, 0)
      assert.equal(f.revoked.length, 1)
    })
  })
  it('retains the native result but refuses successful finalization until cleanup is confirmed', async () => {
    await withFixture(async (f) => {
      f.failCleanup()
      await assert.rejects(f.execute(), /cleanup/)
      assert.equal([...f.rows.values()][0]?.result?.outcome, 'succeeded')
      assert.equal(f.accepted.length, 0)
      assert.equal(f.coordinator.residentRunIds().length, 1)
      assert(!JSON.stringify([[...f.rows.values()], f.events, f.activities]).includes(secret))
    })
  })
  it('redacts native exceptions, output and events at the durable boundary', async () => {
    await withFixture(async (f) => {
      f.setNative(async () => { throw new Error(`provider failed with ${secret}`) })
      await assert.rejects(f.execute(), (error: unknown) => {
        assert(error instanceof Error)
        assert(!error.message.includes(secret))
        return true
      })
      assert(!JSON.stringify([[...f.rows.values()], f.events, f.activities]).includes(secret))
    })
  })
  it('stops before credential expiry without restarting native work', async () => {
    await withFixture(async (f) => {
      f.setExpiresIn(30_150)
      f.setNative(async (signal) => new Promise<ExecutionResult>((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }))
      await assert.rejects(f.execute(), { code: 'WORKER_CREDENTIAL_EXPIRING' })
      assert.equal(f.counters().starts, 1)
      assert.equal([...f.rows.values()][0]?.result?.outcome, 'failed')
      assert.equal(f.revoked.length, 1)
    })
  })
  it('uses one native identity on re-entry, including without a routed approval handler', async () => {
    await withFixture(async (f) => {
      await f.execute(); await f.execute()
      assert.equal(f.counters().creates, 1)
      assert.equal(f.counters().starts, 1)
      assert.equal(f.rows.size, 1)
      assert(!JSON.stringify([f.accepted, f.events]).includes(secret))
    })
  })
  it('uses the management transaction for the Stop credential barrier', async () => {
    await withFixture(async (f) => {
      const controller = new AbortController()
      ;(f.engine as unknown as { activeRuns: Map<string, AbortController> }).activeRuns.set('run-1', controller)
      const client = {} as never
      let released: (() => void) | undefined, passedClient: unknown
      f.credentials.revokeForRun = async (_id, transactionClient) => {
        passedClient = transactionClient
        await new Promise<void>((resolve) => { released = resolve })
        return 1
      }
      let completed = false
      const cancel = f.engine.cancel('run-1', client).then(() => { completed = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(controller.signal.aborted, true)
      assert.equal(completed, false)
      assert.equal(passedClient, client)
      released!()
      await cancel
      assert.equal(completed, true)
    })
  })
})

it('sweeps credentials, cancels orphaned native work and revokes Run authority without replay', async () => {
  const actions: string[] = []
  const owner = { release: async () => { actions.push('release') } }
  const engine = new LangGraphWorkflowEngine({
    reconciliationCandidates: async () => [{ id: 'orphan', executionState: 'running' }],
    acquireOwnership: async () => owner,
    get: async () => ({ id: 'orphan', executionState: 'running' }),
    settleOrphan: async () => { actions.push('settle'); return true },
  } as never, {} as never, {
    reconcileReviews: async () => { actions.push('reviews') },
    cancelRun: async () => { actions.push('native-cancel') },
  } as never, new MemorySaver(), '/tmp/native-orphan', {} as never, {
    prepare: async () => { throw new Error('must not launch during recovery') },
    revoke: async () => undefined, revokeForExecution: async () => 0,
    revokeForRun: async () => { actions.push('revoke'); return 1 },
    reconcileTerminalCredentials: async () => { actions.push('sweep') },
  })
  ;(engine as unknown as { readCheckpoint: () => Promise<unknown> }).readCheckpoint = async () => ({
    version: {}, snapshot: { values: { runId: 'orphan', executionIds: {} }, next: ['node'], tasks: [] },
  })
  await engine.reconcile((error) => { throw error })
  assert.deepEqual(actions, ['sweep', 'reviews', 'native-cancel', 'settle', 'revoke', 'release'])
})
