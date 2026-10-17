import { randomUUID } from 'node:crypto'
import {
  SourceListResultSchema, SourceRootGetInputSchema, SourceRootListResultSchema,
} from '@foreman-code/contracts/source-admission'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from './support.js'

const workspacePath = '/api/management/workspaces/:workspaceId'

export const sourceScenarios: Scenario[] = [
  {
    id: 'sources.empty-catalog', title: 'A new workspace has no approved source snapshots', lane: 'S',
    covers: [httpCoverage('GET', `${workspacePath}/sources`, 'success')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance source catalog')
      const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}/sources`)
      SourceListResultSchema.parse(response.body)
      assertResponse(response, { status: 200, body: { items: [], nextSnapshotId: null } })
    },
  },
  {
    id: 'sources.empty-root-catalog', title: 'A new workspace has no source root bindings or execution readiness', lane: 'S',
    covers: [httpCoverage('GET', `${workspacePath}/source-roots`, 'success')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance root catalog')
      const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}/source-roots`)
      SourceRootListResultSchema.parse(response.body)
      assertResponse(response, { status: 200, body: { items: [], readiness: 'metadata-only' } })
    },
  },
  {
    id: 'sources.missing-root-binding', title: 'Source reads reject a missing exact root binding', lane: 'S',
    covers: [httpCoverage('POST', `${workspacePath}/source-roots/get`, 'error')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance missing root')
      const input = SourceRootGetInputSchema.parse({ workspaceId: created.workspace.id, rootId: randomUUID(), bindingRevision: 1 })
      const response = await ctx.http.request('POST', `/api/management/workspaces/${created.workspace.id}/source-roots/get`, { body: input })
      assertApiError(response, 404, 'SOURCE_ROOT_NOT_FOUND', 'The exact root binding was not found.')
    },
  },
]
