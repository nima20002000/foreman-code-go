import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HarnessExecution, WorkflowRun, WorkflowVersion } from '@graphql/contracts'
import { describe, it } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'

// Derive the callback type from the actual adapter instead of maintaining a
// second local execution contract. The import below is type-only.
type Callbacks = Parameters<ReturnType<import('../src/modules/harnesses/port.js').HarnessResolver['resolve']>['execute']>[1]

type Fixture = Awaited<ReturnType<typeof createFixture>>
async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-pr11-engine-'))
  const configuration = {
    id: 'config-1', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
    prompt: { system: 'Test' }, assignedSkills: [],
    harness: { harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max', nativeAgent: 'build', thinking: false, autoApprove: false },
    contentHash: 'sha256:fixture', createdAt: new Date().toISOString(),
  }
  const run = {
    id: 'run-1', workspaceId: 'workspace-1', workflowId: 'workflow-1', workflowVersionId: 'version-1',
    agentConfigurationVersionIds: { 'agent-1': 'config-1' }, authorizationPrincipalId: 'operator-1',
    executionLocation: { runnerId: 'runner-local', rootPath: directory }, input: {},
    executionState: 'running', outcome: 'pending',
  } as unknown as WorkflowRun
  const version = { definition: { nodes: [{ id: 'node-1', agentId: 'agent-1', initialPrompt: 'Test' }] } } as unknown as WorkflowVersion
  const accepted: HarnessExecution[] = []
  const updated: HarnessExecution[] = []
  const events: unknown[] = []
  const activities: unknown[] = []
  const revoked: string[] = []
  let changedDirectory = false
  let revokedAuthority = false
  let cleanupFails = false
  let spawned = false
  let prepared: () => Promise<void> = async () => undefined
  let expiresIn = 60_000
  let native: (callbacks: Callbacks) => Promise<unknown> = async (callbacks) => {
    await callbacks.beforeSpawn?.()
    spawned = true
    await callbacks.onEvent({ type: 'proof', payload: { unrelated: 'private-pr11-engine-secret' } })
    return { outcome: 'succeeded', output: { text: 'done private-pr11-engine-secret' } }
  }
  const runs = {
    createExecution: async () => undefined,
    updateExecution: async (value: HarnessExecution) => { updated.push(value) },
    acceptExecutionResult: async (value: HarnessExecution) => { accepted.push(value) },
    appendNativeEvent: async (value: unknown) => { events.push(value) },
    recordActivity: async (...args: unknown[]) => { activities.push(args) },
  }
  const credentials: ExecutionCredentialProvider = {
    prepare: async () => {
      await prepared()
      return {
        credential: { principalId: 'worker-1', environment: { agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'private-pr11-engine-secret' } }, expiresAt: new Date(Date.now() + expiresIn).toISOString() },
        detection: {} as never,
      }
    },
    revoke: async () => undefined,
    revokeForExecution: async (id) => { revoked.push(id); if (cleanupFails) throw new Error('database unavailable'); return 1 },
    revokeForRun: async (id) => { revoked.push(id); return 1 },
    reconcileTerminalCredentials: async () => undefined,
  }
  const engine = new LangGraphWorkflowEngine(
    runs as never,
    { getAgentConfiguration: async () => configuration } as never,
    { resolve: () => ({ execute: async (_request: unknown, callbacks: Callbacks) => native(callbacks) }) } as never,
    {} as never, join(directory, 'runtime'), 300_000,
    {
      revalidateRunAuthorization: async () => { if (revokedAuthority) throw new DomainError('AUTH_REVOKED', 'revoked', 401) },
      revalidateSnapshot: async () => { if (changedDirectory) throw new DomainError('WORKSPACE_LOCATION_CHANGED', 'changed', 409) },
    } as never,
    credentials,
  )
  const owner = { assertOwned: () => undefined, client: {} }
  return {
    engine, credentials, accepted, updated, events, activities, revoked,
    setDirectoryChanged: () => { changedDirectory = true },
    setAuthorityRevoked: () => { revokedAuthority = true },
    failCleanup: () => { cleanupFails = true },
    onPrepare: (callback: () => Promise<void>) => { prepared = callback },
    setNative: (callback: (callbacks: Callbacks) => Promise<unknown>) => { native = callback },
    setExpiresIn: (ms: number) => { expiresIn = ms },
    wasSpawned: () => spawned,
    execute: () => (engine as unknown as { executeNode(...args: unknown[]): Promise<unknown> }).executeNode(
      run, version, 'node-1', [], { runId: run.id, executionIds: {} }, new AbortController().signal, owner,
    ),
    close: () => rm(directory, { recursive: true, force: true }),
  }
}
async function withFixture(perform: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture()
  try { await perform(fixture) } finally { await fixture.close() }
}

describe('PR #11 launch, outcome and credential lifecycle', () => {
  it('rechecks directory identity after asynchronous credential preparation', async () => {
    await withFixture(async (fixture) => {
      fixture.onPrepare(async () => fixture.setDirectoryChanged())
      await assert.rejects(fixture.execute(), { code: 'WORKSPACE_LOCATION_CHANGED' })
      assert.equal(fixture.wasSpawned(), false)
      assert.equal(fixture.revoked.length, 1)
    })
  })

  it('rechecks revoked launch authority after asynchronous credential preparation', async () => {
    await withFixture(async (fixture) => {
      fixture.onPrepare(async () => fixture.setAuthorityRevoked())
      await assert.rejects(fixture.execute(), { code: 'AUTH_REVOKED' })
      assert.equal(fixture.wasSpawned(), false)
      assert.equal(fixture.revoked.length, 1)
    })
  })

  it('preserves successful native output while failed cleanup remains retryable', async () => {
    await withFixture(async (fixture) => {
      fixture.failCleanup()
      await fixture.execute()
      assert.equal(fixture.accepted[0]?.result?.outcome, 'succeeded')
      assert.equal(fixture.updated.length, 0)
      assert(JSON.stringify(fixture.activities).includes('retry_pending'))
      assert(!JSON.stringify([fixture.accepted, fixture.events, fixture.activities]).includes('private-pr11-engine-secret'))
    })
  })

  it('redacts a provider exception before either execution or run persistence', async () => {
    await withFixture(async (fixture) => {
      fixture.setNative(async (callbacks) => {
        await callbacks.beforeSpawn?.()
        throw new Error('provider failed with private-pr11-engine-secret')
      })
      await assert.rejects(fixture.execute(), (error: unknown) => {
        assert(error instanceof Error)
        assert(!error.message.includes('private-pr11-engine-secret'))
        return true
      })
      assert(!JSON.stringify([fixture.updated, fixture.events, fixture.activities]).includes('private-pr11-engine-secret'))
    })
  })

  it('stops before actual credential expiry without restarting active native work', async () => {
    await withFixture(async (fixture) => {
      fixture.setExpiresIn(30_050)
      let executions = 0
      fixture.setNative(async (callbacks) => {
        executions += 1
        await callbacks.beforeSpawn?.()
        await new Promise<void>((_resolve, reject) => callbacks.signal.addEventListener('abort', () => reject(callbacks.signal.reason), { once: true }))
        return { outcome: 'succeeded' }
      })
      await assert.rejects(fixture.execute(), { code: 'WORKER_CREDENTIAL_EXPIRING' })
      assert.equal(executions, 1)
      assert.equal(fixture.updated[0]?.result?.outcome, 'failed')
      assert.equal(fixture.revoked.length, 1)
    })
  })

  it('reconciles durable credential cleanup and revokes orphaned runs', async () => {
    const actions: string[] = []
    const owner = { release: async () => { actions.push('release') } }
    const engine = new LangGraphWorkflowEngine({
      reconciliationCandidates: async () => [{ id: 'orphan', executionState: 'running' }],
      acquireOwnership: async () => owner,
      settleOrphan: async () => { actions.push('settle'); return true },
    } as never, {} as never, {} as never, {} as never, '/tmp/pr11-test', 300_000, {} as never, {
      prepare: async () => { throw new Error('must not launch during recovery') },
      revoke: async () => undefined, revokeForExecution: async () => 0,
      revokeForRun: async () => { actions.push('revoke'); return 1 },
      reconcileTerminalCredentials: async () => { actions.push('sweep') },
    })
    await engine.reconcile((error) => { throw error })
    assert.deepEqual(actions, ['sweep', 'settle', 'revoke', 'release'])
  })

  it('uses the management transaction for the Stop barrier before returning', async () => {
    await withFixture(async (fixture) => {
      const controller = new AbortController()
      ;(fixture.engine as unknown as { activeRuns: Map<string, AbortController> }).activeRuns.set('run-1', controller)
      const client = {} as never
      let released: (() => void) | undefined
      let passedClient: unknown
      fixture.credentials.revokeForRun = async (_id, transactionClient) => {
        passedClient = transactionClient
        await new Promise<void>((resolve) => { released = resolve })
        return 1
      }
      let completed = false
      const cancel = fixture.engine.cancel('run-1', client).then(() => { completed = true })
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
