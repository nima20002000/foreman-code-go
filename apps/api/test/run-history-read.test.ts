import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { ManagementPrincipalSchema } from '@graphql/contracts/management'
import { readRunHistory } from '../src/modules/runs/runHistory.js'
import { RunManagementService } from '../src/modules/runs/management.js'

const scope = { workspaceId: 'workspace-history', workflowId: 'workflow-history', runId: 'run-history',
  workflowVersionId: 'workflow-history-v1', executionSemanticsVersion: 1 as const }
const createdAt = '2026-09-24T00:00:00.000Z'
function row() {
  return {
    run: { id: scope.runId, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      workflowVersionId: scope.workflowVersionId, agentConfigurationVersionIds: { 'agent-history': 'config-v1' },
      executionCondition: { kind: 'manual' }, executionState: 'completed', outcome: 'succeeded', input: {},
      result: { outcome: 'succeeded', output: { text: 'old-result' } }, createdAt, finishedAt: createdAt },
    version_pin: 1,
    version: { id: scope.workflowVersionId, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      version: 1, entryNodeId: 'node-history', agentConfigurationVersionIds: { 'agent-history': 'config-v1' },
      definition: { id: scope.workflowId, workspaceId: scope.workspaceId, name: 'History', version: 1,
        executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
        nodes: [{ id: 'node-history', agentId: 'agent-history', name: 'coder-001', initialPrompt: 'SECRET PROMPT' }], edges: [] },
      contentHash: 'sha256:test', createdAt },
    configurations: [{ id: 'config-v1', workspaceId: scope.workspaceId, agentId: 'agent-history',
      version: 1, prompt: { system: 'SECRET SYSTEM' }, assignedSkills: [], resolvedSkills: [],
      harness: { harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium',
        sandbox: 'read-only', serviceTier: 'standard' }, contentHash: 'sha256:test', createdAt }],
    latest_results: [{ id: 'execution-history', runId: scope.runId, workflowNodeId: 'node-history',
      agentId: 'agent-history', agentConfigurationVersionId: 'config-v1', attempt: 1, state: 'completed',
      outcome: 'succeeded', output_preview: 'old-result', output_truncated: false }],
  }
}

describe('historical Run read', () => {
  it('returns pinned v1 topology, Agent model/effort and result without prompts or activity', async () => {
    const query = vi.fn(async () => ({ rows: [row()] }))
    const result = await readRunHistory({ query } as unknown as Pick<pg.Pool, 'query'>, scope, true)
    expect(result).toMatchObject({ version: 1, nodes: [{ name: 'coder-001' }],
      agentConfigurations: [{ model: 'gpt-5.6-luna', reasoningEffort: 'medium' }],
      runResult: { outcome: 'succeeded', outputPreview: 'old-result' },
      latestResults: [{ outputPreview: 'old-result' }] })
    expect(JSON.stringify(result)).not.toMatch(/SECRET|prompt|skills|advanced|activity/i)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual([scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, true])
    expect(sql).toMatch(/order by e\.attempt desc limit 1/)
    expect(sql).not.toMatch(/run_activity|harness_native_events|offset\s/i)
  })
  it('omits Agent settings without the additional grant and rejects a mismatched result pin', async () => {
    const denied = row(); denied.configurations = []
    const query = vi.fn(async () => ({ rows: [denied] }))
    const result = await readRunHistory({ query } as unknown as Pick<pg.Pool, 'query'>, scope, false)
    expect(result?.nodes[0]?.agentConfigurationVersionId).toBe('config-v1')
    expect(result?.agentConfigurations).toEqual([])
    expect((query.mock.calls as unknown as Array<[string, unknown[]]>)[0]?.[1]?.at(-1)).toBe(false)
    const mismatch = row(); mismatch.latest_results[0]!.agentConfigurationVersionId = 'config-v3'
    query.mockResolvedValueOnce({ rows: [mismatch] })
    await expect(readRunHistory({ query } as unknown as Pick<pg.Pool, 'query'>, scope, true))
      .rejects.toMatchObject({ code: 'RUN_IDENTITY_INVALID' })
  })
  it('rejects a v2 saved semantics pin rather than interpreting it as old topology', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row(), version_pin: 2 }] }))
    await expect(readRunHistory({ query } as unknown as Pick<pg.Pool, 'query'>, scope, true))
      .rejects.toMatchObject({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
  })
  it('checks the exact Run grant before SQL and gates Agent settings separately', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row(), configurations: [] }] }))
    type Args = ConstructorParameters<typeof RunManagementService>
    const service = new RunManagementService({ query } as unknown as pg.Pool,
      {} as Args[1], {} as Args[2], {} as Args[3], {} as Args[4])
    const principal = ManagementPrincipalSchema.parse({ id: 'operator-history', name: 'History operator',
      audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: [scope.workspaceId],
        workflowIds: [scope.workflowId], runIds: [scope.runId] } }] })
    await expect(service.history(principal, { ...scope, runId: 'foreign-run' })).rejects.toMatchObject({ status: 403 })
    expect(query).not.toHaveBeenCalled()
    const result = await service.history(principal, scope)
    expect(result.agentConfigurations).toEqual([])
    expect((query.mock.calls as unknown as Array<[string, unknown[]]>)[0]?.[1]?.at(-1)).toBe(false)
  })
})
