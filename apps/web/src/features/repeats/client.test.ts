import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { RepeatWorkflowVersionV1Schema, makeWave25Fixture, type RepeatPlanV1 } from '@graphql/contracts/wave25'
import { ApiClient } from '../../shared/api/client'
import { server } from '../../mocks/server'
import { createRepeatClient } from './client'

function fixture() {
  const base = makeWave25Fixture('repeat-http')
  const [entry, exit] = base.version.definition.nodes
  const graph = { ...base.version.definition, executionPolicy: { ...base.version.definition.executionPolicy!, maxNodeExecutions: 6 },
    nodes: [entry!, { ...exit!, choice: { outcomes: [
      { outcome: 'issues', target: { kind: 'branch_end' as const } },
      { outcome: 'pass', target: { kind: 'branch_end' as const } },
    ] } }],
  }
  const repeat: RepeatPlanV1 = { contractVersion: 1, blocks: [{ id: 'review-fix', nodeIds: graph.nodes.map((node) => node.id),
    entryNodeId: graph.nodes[0]!.id, exitNodeId: graph.nodes[1]!.id, maxOccurrences: 2,
    repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
  const version = RepeatWorkflowVersionV1Schema.parse({ ...base.version, id: 'wv-repeat-http', executionSemanticsVersion: 3,
    definition: { ...graph, executionSemanticsVersion: 3, repeat } })
  return { base, graph, repeat, version }
}

const capabilities = { contractVersion: 1 as const, executionSemanticsVersion: 3 as const, supported: false as const,
  authoring: { flatScopesOnly: true as const, nesting: false as const, arbitraryCycles: false as const,
    maxOccurrencesMin: 1 as const, maxOccurrencesMax: 2147483647 as const, explicitLimitExit: true as const, earlyExitOutcome: true as const },
  availability: { savedAuthoring: true as const, persistedReadback: true, runtimeAdmission: false as const, meaningfulEdit: false as const,
    reasons: ['NATIVE_START_NOT_READY', 'REPEAT_EDIT_INTENT_NOT_READY'] as const } }

describe('repeatClient HTTP contract', () => {
  it('uses the authenticated management routes and shared schemas for every mounted query', async () => {
    const { base, graph, version } = fixture()
    const client = createRepeatClient(new ApiClient())
    const seen: string[] = []
    server.use(
      http.get('/api/management/repeats/capabilities', ({ request }) => {
        const url = new URL(request.url); seen.push(`cap:${url.searchParams.get('workspaceId')}:${url.searchParams.get('workflowId')}`)
        return HttpResponse.json(capabilities)
      }),
      http.get('/api/management/workspaces/:workspaceId/workflows/:workflowId', () => {
        seen.push('workflow'); return HttpResponse.json({ workflow: graph, revision: 4, currentVersionId: version.id, archivedAt: null })
      }),
      http.get('/api/management/workspaces/:workspaceId', ({ params }) => {
        seen.push('workspace'); return HttpResponse.json({ workspace: { id: String(params.workspaceId), name: 'Repeat workspace' }, revision: 2,
          archivedAt: null, executionLocation: null, locationRevision: 7, locationValidation: { status: 'unconfigured' } })
      }),
      http.get('/api/management/workspaces/:workspaceId/workflows/:workflowId/repeat', () => {
        seen.push('repeat'); return HttpResponse.json({ contractVersion: 1, executionSemanticsVersion: 3,
          workspaceId: base.version.workspaceId, workflowId: base.version.workflowId, revision: 4, currentVersionId: version.id, version })
      }),
      http.get('/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/repeats', ({ request, params }) => {
        const url = new URL(request.url); seen.push(`run:${url.searchParams.get('includeResultData')}:${url.searchParams.get('limit')}`)
        return HttpResponse.json({ contractVersion: 1, executionSemanticsVersion: 3,
          workspaceId: base.version.workspaceId, workflowId: base.version.workflowId, runId: String(params.runId), items: [], pageInfo: { nextCursor: null } })
      }),
    )

    await expect(client.capabilities(base.version.workspaceId, base.version.workflowId)).resolves.toEqual(capabilities)
    await expect(client.workflowMeta(base.version.workspaceId, base.version.workflowId)).resolves.toMatchObject({ revision: 4, currentVersionId: version.id })
    await expect(client.workspaceMeta(base.version.workspaceId)).resolves.toMatchObject({ locationRevision: 7 })
    await expect(client.get({ workspaceId: base.version.workspaceId, workflowId: base.version.workflowId })).resolves.toMatchObject({ currentVersionId: version.id })
    await expect(client.run({ workspaceId: base.version.workspaceId, workflowId: base.version.workflowId, runId: 'run-repeat-http', limit: 100,
      includeResultData: true })).resolves.toMatchObject({ runId: 'run-repeat-http', items: [] })
    expect(seen).toEqual([`cap:${base.version.workspaceId}:${base.version.workflowId}`, 'workflow', 'workspace', 'repeat', 'run:true:100'])
  })
})
