import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { RepeatReadbackService } from '../src/modules/repeats/readback.js'
import { normalizeRepeatTerminal } from '../src/modules/runs/repeatNode.js'
import { repeatExecutionDriver } from '../src/modules/runs/repeatRuntime.js'
import {
  createRepeatHarness,
  exitDecision,
  firstOccurrence,
  makeSimpleRepeatFixture,
  repeatExitOutput,
  successfulExecution,
  executionFor,
} from './helpers/eng04RepeatFixtures.js'

const providerShapes = [
  {
    harness: 'codex',
    providerVersion: 'codex-provider-shaped-0.154.0',
    nativeSessionId: 'codex-session-eng04-d-0001',
    nativeTurnId: 'codex-turn-eng04-d-0001',
    nativeRequestId: 'codex-request-eng04-d-0001',
  },
  {
    harness: 'opencode',
    providerVersion: 'opencode-provider-shaped-current',
    nativeSessionId: 'opencode-session-eng04-d-0001',
    nativeTurnId: 'opencode-turn-eng04-d-0001',
    nativeRequestId: 'opencode-request-eng04-d-0001',
  },
] as const

function principal(actions: ManagementPrincipal['grants'][number]['actions'], workflowId = 'wf-eng04-d-readback'): ManagementPrincipal {
  return {
    id: `principal-${workflowId}`,
    name: 'ENG04-D reader',
    audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null,
    grants: [{ actions, scope: { workspaceIds: ['ws-eng04-d-readback'], workflowIds: [workflowId] } }],
  }
}

describe('NIM-2648 ENG04-D provider-shaped and persisted readback regression', () => {
  it.each(providerShapes)('coalesces concurrent duplicate $harness observation by exact execution ID without inventing provider evidence', async (trace) => {
    const fixture = makeSimpleRepeatFixture(1, { suffix: 'eng04-d-provider' })
    const harness = createRepeatHarness(fixture)
    const occurrence = await harness.enter()
    const execution = await harness.admit(occurrence, 'work', `${trace.harness}-execution-eng04-d-0001`)
    const observed: Array<typeof trace & { executionId: string }> = []
    let release!: () => void
    const boundary = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const observationStarted = new Promise<void>((resolve) => { started = resolve })
    const driver = repeatExecutionDriver({
      scope: fixture.scope,
      version: fixture.version,
      owner: harness.owner,
      store: harness.store,
      observeExact: async (stored) => {
        observed.push({ ...trace, executionId: stored.id })
        started()
        await boundary
      },
    })
    const signal = new AbortController().signal
    const first = driver.observe(execution, signal)
    const duplicate = driver.observe({ ...execution, input: { checkpointNoise: true } }, signal)
    await observationStarted
    expect(observed).toEqual([{ ...trace, executionId: execution.id }])
    release()
    await Promise.all([first, duplicate])
    expect(observed).toHaveLength(1)
    expect(observed[0]!.nativeSessionId).toBe(trace.nativeSessionId)
    expect(observed[0]!.nativeTurnId).toBe(trace.nativeTurnId)
    expect(observed[0]!.nativeRequestId).toBe(trace.nativeRequestId)
  })

  it('fails closed when a provider-shaped successful terminal hides the repeat envelope inside prose/text', () => {
    const fixture = makeSimpleRepeatFixture(2)
    const occurrence = firstOccurrence(fixture).occurrence
    const ref = { nodeId: 'review', occurrence: occurrence.identity }
    const validOutput = repeatExitOutput(1, 'issues')
    const textCarried = successfulExecution(executionFor(fixture, 'review', 'raw-provider-text-terminal'), {
      text: `provider prefix ${JSON.stringify(validOutput)} provider suffix`,
      rawProviderResultId: 'provider-result-text-0001',
    })
    const normalized = normalizeRepeatTerminal(fixture.version, fixture.scope, ref, textCarried)
    expect(normalized.result?.outcome).toBe('failed')
    expect(normalized).not.toEqual(textCarried)
  })

  it('reads persisted exact occurrence/decision IDs with private result data opt-in and rejects a store row that escapes Run scope', async () => {
    const fixture = makeSimpleRepeatFixture(2, { suffix: 'eng04-d-readback', runId: 'run-eng04-d-readback' })
    const first = firstOccurrence(fixture)
    const { decision } = exitDecision(fixture, first.occurrence, 'issues', 'readback-review-exec-1')
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      workflow_version_id: fixture.version.id,
      record: { executionSemanticsVersion: 3 },
    }] }) } as unknown as pg.Pool
    const store = {
      list: vi.fn(async (input: { includeResultData: boolean }) => {
        const { resultData: _private, ...metadata } = decision
        void _private
        return { items: [{ occurrence: first.occurrence, decision: input.includeResultData ? decision : metadata }], nextCursor: null }
      }),
    }
    const service = new RepeatReadbackService(pool, store)
    const p: ManagementPrincipal = {
      id: 'principal-readback', name: 'reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
      grants: [{ actions: ['workflows:read', 'graph:read', 'runs:read'], scope: {
        workspaceIds: [fixture.scope.workspaceId], workflowIds: [fixture.scope.workflowId], runIds: [fixture.scope.runId],
      } }],
    }
    const metadata = await service.run(p, {
      workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, runId: fixture.scope.runId,
      limit: 50, includeResultData: false,
    })
    expect(metadata.items[0]!.occurrence.identity.occurrenceId).toBe(first.occurrence.identity.occurrenceId)
    expect(metadata.items[0]!.decision?.decisionId).toBe(decision.decisionId)
    expect(metadata.items[0]!.decision && 'resultData' in metadata.items[0]!.decision).toBe(false)

    const detailed = await service.run(p, {
      workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, runId: fixture.scope.runId,
      limit: 50, includeResultData: true,
    })
    expect(detailed.items[0]!.decision && 'resultData' in detailed.items[0]!.decision).toBe(true)

    const foreignStore = {
      list: async () => ({ items: [{ occurrence: {
        ...first.occurrence,
        identity: { ...first.occurrence.identity, scope: { ...first.occurrence.identity.scope, runId: 'foreign-run-id' } },
      }, decision: null }], nextCursor: null }),
    }
    const foreign = new RepeatReadbackService(pool, foreignStore)
    await expect(foreign.run(p, {
      workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, runId: fixture.scope.runId,
      limit: 50, includeResultData: false,
    })).rejects.toMatchObject({ code: 'REPEAT_READBACK_SCOPE_INVALID' })
  })

  it('denies a wrong-workflow read-only caller before any persisted Run lookup', async () => {
    const query = vi.fn()
    const service = new RepeatReadbackService({ query } as unknown as pg.Pool, { list: vi.fn() })
    const p = principal(['workflows:read', 'graph:read', 'runs:read'], 'other-workflow')
    await expect(service.run(p, {
      workspaceId: 'ws-eng04-d-readback', workflowId: 'wf-eng04-d-readback', runId: 'run-eng04-d-readback',
      limit: 50, includeResultData: false,
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
    expect(query).not.toHaveBeenCalled()
  })
})
