import { randomUUID } from 'node:crypto'
import {
  ManagedWorkspaceCommandResultSchema,
  ManagedWorkspaceSchema,
  WorkspaceArchiveInputSchema,
  WorkspaceBatchArchiveInputSchema,
  WorkspaceBatchArchiveResultSchema,
  type ManagedWorkspace,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage, readWorkspace } from '../smoke/support.js'
import { assertProtectedRead } from './support.js'

const collectionPath = '/api/management/workspaces'
const workspacePath = `${collectionPath}/:workspaceId`
const batchPath = `${collectionPath}/batch-archive`

export const workspaceArchiveScenario: Scenario = {
  id: 'http.workspaces.archive',
  title: 'Workspace archival is revision checked, replayable, and visible in archived reads',
  lane: 'A2',
  covers: [
    httpCoverage('DELETE', workspacePath, 'success'),
    httpCoverage('DELETE', workspacePath, 'error'),
  ],
  async run(ctx) {
    const { created } = await createWorkspace(ctx, 'Workspace archive receipt')
    const path = `${collectionPath}/${created.workspace.id}`
    const input = WorkspaceArchiveInputSchema.parse({
      workspaceId: created.workspace.id, commandId: randomUUID(), expectedRevision: 1,
    })
    assertApiError(await ctx.http.request('DELETE', path, {
      body: { ...input, commandId: randomUUID(), expectedRevision: 0 },
    }), 409, 'REVISION_CONFLICT', 'The workspace changed since it was read.', { currentRevision: 1 })
    await readWorkspace(ctx, created)

    const response = await ctx.http.request('DELETE', path, { body: input })
    const archived = ManagedWorkspaceCommandResultSchema.parse(response.body).value
    assertResponse(response, {
      status: 200,
      body: { value: { ...created, revision: 2, archivedAt: '<timestamp>' }, replayed: false },
    }, [{ pointer: '/body/value/archivedAt', kind: 'timestamp' }])
    assertResponse(await ctx.http.request('DELETE', path, { body: input }), {
      status: 200, body: { value: archived, replayed: true },
    })
    await readWorkspace(ctx, archived)
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { commandId: randomUUID(), expectedRevision: 2, name: 'Archived edit' },
    }), 409, 'WORKSPACE_ARCHIVED', 'Archived workspaces cannot be edited.')
    await assertProtectedRead(ctx, collectionPath, { items: [], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${collectionPath}?includeArchived=true`, {
      items: [{ ...archived, locationValidation: { status: 'unconfigured' } }],
      pageInfo: { nextCursor: null },
    })
  },
}

async function readBatchArchivedWorkspace(ctx: ScenarioContext, created: ManagedWorkspace) {
  const response = await ctx.http.request('GET', `${collectionPath}/${created.workspace.id}`)
  const archived = ManagedWorkspaceSchema.parse(response.body)
  assertResponse(response, {
    status: 200,
    body: { ...created, revision: 2, archivedAt: '<timestamp>', locationValidation: { status: 'unconfigured' } },
  }, [{ pointer: '/body/archivedAt', kind: 'timestamp' }])
  return archived
}

export const workspaceBatchArchiveScenario: Scenario = {
  id: 'http.workspaces.batch-archive',
  title: 'Workspace pagination and atomic batch archive preserve every selected revision',
  lane: 'A2',
  covers: [
    httpCoverage('POST', batchPath, 'success'),
    httpCoverage('POST', batchPath, 'error'),
  ],
  async run(ctx) {
    const first = await createWorkspace(ctx, 'First batch workspace')
    const second = await createWorkspace(ctx, 'Second batch workspace')
    const created = [first.created, second.created].sort((left, right) =>
      left.workspace.id.localeCompare(right.workspace.id))
    const readable = created.map(item => ({ ...item, locationValidation: { status: 'unconfigured' } }))
    const firstId = created[0]!.workspace.id
    await assertProtectedRead(ctx, `${collectionPath}?limit=1`, {
      items: [readable[0]], pageInfo: { nextCursor: firstId },
    })
    await assertProtectedRead(ctx, `${collectionPath}?limit=1&cursor=${encodeURIComponent(firstId)}`, {
      items: [readable[1]], pageInfo: { nextCursor: null },
    })

    const input = WorkspaceBatchArchiveInputSchema.parse({
      commandId: randomUUID(),
      workspaces: created.map(item => ({ workspaceId: item.workspace.id, expectedRevision: 1 })).reverse(),
    })
    assertApiError(await ctx.http.request('POST', batchPath, {
      body: { ...input, commandId: randomUUID(), workspaces: [
        input.workspaces[0], { workspaceId: 'workspace-missing', expectedRevision: 1 },
      ] },
    }), 404, 'WORKSPACE_NOT_FOUND', 'A selected workspace was not found. Nothing was deleted.')
    assertApiError(await ctx.http.request('POST', batchPath, {
      body: { ...input, commandId: randomUUID(), workspaces: input.workspaces.map(item => ({
        ...item, expectedRevision: 0,
      })) },
    }), 409, 'REVISION_CONFLICT', 'A selected workspace changed. Nothing was deleted. Reload the list and select again.')
    await assertProtectedRead(ctx, collectionPath, { items: readable, pageInfo: { nextCursor: null } })

    const response = await ctx.http.request('POST', batchPath, { body: input })
    WorkspaceBatchArchiveResultSchema.parse(response.body)
    const value = { workspaceIds: created.map(item => item.workspace.id) }
    assertResponse(response, { status: 200, body: { value, replayed: false } })
    assertResponse(await ctx.http.request('POST', batchPath, { body: input }), {
      status: 200, body: { value, replayed: true },
    })
    const archived: ManagedWorkspace[] = []
    for (const item of created) archived.push(await readBatchArchivedWorkspace(ctx, item))
    await assertProtectedRead(ctx, collectionPath, { items: [], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${collectionPath}?includeArchived=true`, {
      items: archived, pageInfo: { nextCursor: null },
    })
  },
}
