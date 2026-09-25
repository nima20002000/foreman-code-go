import { describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import type pg from 'pg'
import { makeWave25Fixture, type RepeatWorkflowVersionV1 } from '@graphql/contracts/wave25'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { RepeatAuthoringService } from '../src/modules/repeats/authoring.js'
import { RepeatReadbackService } from '../src/modules/repeats/readback.js'
import { registerRepeatTools } from '../src/mcp/operator/repeats.js'

const expiresAt = '2099-01-01T00:00:00.000Z'
function principal(actions: ManagementPrincipal['grants'][number]['actions'], workflowIds?: string[]): ManagementPrincipal {
  return { id: `principal-${actions.length}`, name: 'Operator', audience: 'operator', expiresAt, revokedAt: null,
    grants: [{ actions, scope: { workspaceIds: ['workspace-repeat'], ...(workflowIds ? { workflowIds } : {}) } }] }
}
function candidate(): RepeatWorkflowVersionV1 {
  const baseline = makeWave25Fixture('eng04-b').version
  const names = ['work', 'review', 'done', 'limit']
  return {
    ...baseline, id: 'workflow-repeat-v2', workspaceId: 'workspace-repeat', workflowId: 'workflow-repeat',
    version: 2, entryNodeId: 'work', executionSemanticsVersion: 3,
    agentConfigurationVersionIds: Object.fromEntries(names.map((id) => [`agent-${id}`, `config-${id}`])),
    definition: {
      ...baseline.definition, id: 'workflow-repeat', workspaceId: 'workspace-repeat', version: 2,
      entryNodeId: 'work', executionSemanticsVersion: 3,
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 8 },
      nodes: names.map((id) => ({ id, agentId: `agent-${id}`, name: id, ...(id === 'review' ? { choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'edge' as const, relationshipId: 'review-done' } },
        { outcome: 'issues', target: { kind: 'edge' as const, relationshipId: 'review-limit' } },
      ] } } : {}) })),
      edges: [
        { id: 'work-review', kind: 'execution', source: 'work', target: 'review' },
        { id: 'review-done', kind: 'execution', source: 'review', target: 'done' },
        { id: 'review-limit', kind: 'execution', source: 'review', target: 'limit' },
      ],
      repeat: { contractVersion: 1, blocks: [{ id: 'review-fix', nodeIds: ['work', 'review'], entryNodeId: 'work', exitNodeId: 'review',
        maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'edge', relationshipId: 'review-limit' } }] },
    },
  }
}

describe('NIM-2646 repeat HTTP/MCP lane', () => {
  it('MCP exposes UI-equivalent save/read tools to a fully authorized Operator', () => {
    const registered = new Map<string, unknown>()
    const server = { registerTool(name: string, _definition: unknown, handler: unknown) { registered.set(name, handler) } } as unknown as McpServer
    const p = principal(['capabilities:read','workflows:read','workflows:update','graph:read','graph:edit','graph:save','runs:read'])
    registerRepeatTools(server, {
      principal: p,
      commands: { recordDenied: vi.fn() } as never,
      authoring: { capabilities: vi.fn(), save: vi.fn() } as never,
      readback: { workflow: vi.fn(), run: vi.fn() } as never,
      available: () => true,
    })
    expect([...registered.keys()].sort()).toEqual(['repeat_capabilities_get','repeat_get','repeat_run_get','repeat_update'])
  })

  it('does not advertise write authoring to a read-only Operator', () => {
    const registered = new Set<string>()
    const server = { registerTool(name: string) { registered.add(name) } } as unknown as McpServer
    const p = principal(['capabilities:read','workflows:read','graph:read','runs:read'])
    registerRepeatTools(server, { principal: p, commands: { recordDenied: vi.fn() } as never,
      authoring: {} as never, readback: {} as never,
      available: (name) => name !== 'repeat_update' })
    expect(registered.has('repeat_update')).toBe(false)
    expect(registered.has('repeat_get')).toBe(true)
  })

  it('rejects a wrong-workflow scoped writer before any command or database work', async () => {
    const execute = vi.fn()
    const service = new RepeatAuthoringService({} as pg.Pool, { execute } as never)
    const p = principal(['workflows:read','workflows:update','graph:read','graph:edit','graph:save'], ['other-workflow'])
    await expect(service.save(p, 'mcp', {
      workspaceId: 'workspace-repeat', workflowId: 'workflow-repeat', commandId: 'command-repeat-1',
      expectedRevision: 1, expectedWorkflowVersionId: 'workflow-repeat-v1', executionSemanticsVersion: 3,
      repeat: candidate().definition.repeat,
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reads back the exact persisted v3 version instead of reconstructing repeat state', async () => {
    const version = candidate()
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      revision: '9', current_version_id: version.id, version_record: version, execution_semantics_version: 3,
    }] }) } as unknown as pg.Pool
    const service = new RepeatReadbackService(pool)
    const p = principal(['workflows:read','graph:read'], ['workflow-repeat'])
    const result = await service.workflow(p, { workspaceId: 'workspace-repeat', workflowId: 'workflow-repeat' })
    expect(result.revision).toBe(9)
    expect(result.currentVersionId).toBe(version.id)
    expect(result.version.definition.repeat).toEqual(version.definition.repeat)
  })

  it('fails explicitly when A occurrence storage is not wired, rather than fabricating Run repeat state', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      workflow_version_id: 'workflow-repeat-v2', record: { executionSemanticsVersion: 3 },
    }] }) } as unknown as pg.Pool
    const service = new RepeatReadbackService(pool)
    const p = principal(['workflows:read','graph:read','runs:read'], ['workflow-repeat'])
    await expect(service.run(p, { workspaceId: 'workspace-repeat', workflowId: 'workflow-repeat', runId: 'run-repeat', limit: 50, includeResultData: false }))
      .rejects.toMatchObject({ code: 'REPEAT_RUNTIME_READBACK_UNAVAILABLE', status: 503 })
  })
})
