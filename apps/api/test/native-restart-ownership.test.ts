import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type HarnessExecution,
  type NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { DomainError } from '../src/modules/errors.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { nativeLanes } from './helpers/nativeLanes.js'

vi.mock('../src/modules/interactions/retainedRemoteReviewer.js', () => {
  const retained = (_sql: unknown, execution: HarnessExecution) => ({
    generation: execution.id, principalId: `principal:${execution.id}`,
    session: { harness: 'codex', providerVersion: 'fixture', nativeSessionId: execution.nativeSessionId },
  })
  return {
    readRecoverableRemoteReviewer: async (sql: unknown, execution: HarnessExecution) => ({
      ...retained(sql, execution), detached: false,
    }),
    readRetainedRemoteReviewer: async (sql: unknown, execution: HarnessExecution) => retained(sql, execution),
    retainRemoteReviewerCredential: async () => {},
  }
})

it('shares one reacquired Run owner across sibling retained session detachment', async () => {
  const createdAt = '2026-10-01T00:00:00.000Z'
  const configuration: AgentConfigurationVersion = {
    id: 'configuration', agentId: 'reviewer', workspaceId: 'workspace', version: 1,
    productRole: 'orchestrator', prompt: { system: 'Review assigned interactions' }, assignedSkills: [],
    harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'fixture', createdAt,
  }
  const executions: HarnessExecution[] = ['first', 'second'].map(id => ({
    id, runId: 'run', workflowNodeId: `node:${id}`, agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: {}, state: 'completed',
    nativeSessionId: `session:${id}`, workingDirectory: '/project', runtimeDirectory: `/runtime/${id}`,
    result: { outcome: 'succeeded' }, createdAt, finishedAt: createdAt,
  }))
  const sessions = new Map(executions.map(execution => [execution.id, {
    harness: 'codex', providerVersion: 'fixture', nativeSessionId: execution.nativeSessionId!,
  } satisfies NativeSessionReference]))
  const owners: RunOwnership[] = []
  let locked = false
  const acquireOwnership = vi.fn(async () => {
    if (locked) return undefined
    locked = true
    let owned = true
    let retained = 0
    let releaseRequested = false
    const finish = () => {
      if (releaseRequested && retained === 0) {
        owned = false
        locked = false
      }
    }
    const owner = {
      runId: 'run',
      assertOwned() {
        if (!owned) throw new DomainError('RUN_OWNERSHIP_LOST', 'The Run owner has released its lock.', 409)
      },
      oneShotConnection: () => ({ transaction: async (work: (sql: unknown) => Promise<unknown>) => work({}) }),
      retain() {
        owner.assertOwned()
        retained++
        return async () => {
          retained--
          finish()
        }
      },
      release: async () => {
        releaseRequested = true
        finish()
      },
    } as unknown as RunOwnership
    owners.push(owner)
    return owner
  })
  const closeOwners: RunOwnership[] = []
  const managers = new ExecutionScopedNativeSessionManagerResolver((context, getOwner) => ({
    harness: 'codex', retainsReviewerSession: true,
    attachSession: async () => sessions.get(context.executionId)!,
    originalApplicationAccess: async () => ({}),
    closeForRestart: async (session: NativeSessionReference) => {
      expect(session).toEqual(sessions.get(context.executionId))
      const owner = getOwner()!
      owner.assertOwned()
      closeOwners.push(owner)
    },
    dispose: async () => {},
  } as unknown as NativeHarnessSessionManager))
  const coordination = nativeLanes()
  vi.spyOn(coordination, 'workflowSession').mockImplementation(async id => ({
    session: sessions.get(id)!, finalized: true, reviewerActive: false,
  }))
  const detached = vi.fn(async (_execution: HarnessExecution, _session: NativeSessionReference,
    _generation: string, assertCurrent: () => void) => {
    expect(locked).toBe(true)
    assertCurrent()
  })
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator({
    acquireOwnership,
    getExecution: async (id: string) => executions.find(execution => execution.id === id),
    getExecutionConfiguration: async () => configuration,
    get: async () => ({ id: 'run', workspaceId: 'workspace', executionState: 'waiting', outcome: 'pending',
      approval: { handler: 'orchestrator', designatedOrchestratorAgentId: configuration.agentId } }),
  } as unknown as Args[0], { coordination } as unknown as Args[1], {} as Args[2], managers, 60_000, {
    recoverRemote: async (id: string) => ({ principalId: `principal:${id}`,
      environment: { agentId: configuration.agentId, variables: {} },
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  } as unknown as Args[5], undefined, { recordDetached: detached } as unknown as Args[7],
  undefined, undefined, undefined, undefined, undefined, async context => ({
    ...context, acceptedPlacement: { hostRef: { kind: 'device' } } as NonNullable<typeof context.acceptedPlacement>,
  }))
  for (const execution of executions) {
    await coordinator.attachOwnedSession({ harness: 'codex', executionId: execution.id,
      agentId: execution.agentId, workingDirectory: execution.workingDirectory!, purpose: 'reviewer' },
    sessions.get(execution.id)!)
    await coordinator.releaseReviewSession(execution.id)
    expect(locked).toBe(false)
  }
  const acquisitions = acquireOwnership.mock.calls.length
  await coordinator.closeForRestart()
  expect(acquireOwnership.mock.calls.length).toBe(acquisitions + 1)
  expect(closeOwners).toEqual([owners.at(-1), owners.at(-1)])
  expect(detached).toHaveBeenCalledTimes(2)
  expect(locked).toBe(false)
  await managers.dispose()
})
