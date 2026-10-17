import { randomUUID } from 'node:crypto'
import {
  ManagedWorkspaceCommandResultSchema,
  WorkspaceUpdateInputSchema,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead, readCoverage } from './support.js'

const collectionPath = '/api/management/workspaces'
const workspacePath = `${collectionPath}/:workspaceId`

export const workspaceMutationScenario: Scenario = {
  id: 'http.workspaces.create-read-update',
  title: 'Workspace creation, replay, update, and stale revision preserve public state',
  lane: 'A2',
  covers: [
    ...readCoverage(collectionPath),
    ...readCoverage(workspacePath),
    httpCoverage('POST', collectionPath, 'success'),
    httpCoverage('POST', collectionPath, 'error'),
    httpCoverage('PATCH', workspacePath, 'success'),
    httpCoverage('PATCH', workspacePath, 'error'),
  ],
  async run(ctx) {
    await assertProtectedRead(ctx, collectionPath, { items: [], pageInfo: { nextCursor: null } })
    const { input, created } = await createWorkspace(ctx, 'Workspace metadata round trip')
    const path = `${collectionPath}/${created.workspace.id}`
    const readable = { ...created, locationValidation: { status: 'unconfigured' } }
    await assertProtectedRead(ctx, path, readable)

    assertResponse(await ctx.http.request('POST', collectionPath, { body: input }), {
      status: 200, body: { value: created, replayed: true },
    })
    assertApiError(await ctx.http.request('POST', collectionPath, {
      body: { ...input, name: 'Conflicting command input' },
    }), 409, 'COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')
    await assertProtectedRead(ctx, collectionPath, { items: [readable], pageInfo: { nextCursor: null } })

    const update = WorkspaceUpdateInputSchema.parse({
      workspaceId: created.workspace.id, commandId: randomUUID(), expectedRevision: 1,
      name: 'Updated workspace metadata', description: null,
    })
    const response = await ctx.http.request('PATCH', path, { body: update })
    const updated = ManagedWorkspaceCommandResultSchema.parse(response.body).value
    assertResponse(response, {
      status: 200,
      body: {
        value: {
          ...readable,
          workspace: {
            id: created.workspace.id, name: update.name,
            createdAt: created.workspace.createdAt, updatedAt: '<timestamp>',
          },
          revision: 2,
        },
        replayed: false,
      },
    }, [{ pointer: '/body/value/workspace/updatedAt', kind: 'timestamp' }])
    assertResponse(await ctx.http.request('PATCH', path, { body: update }), {
      status: 200, body: { value: updated, replayed: true },
    })
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...update, commandId: randomUUID(), name: 'Stale edit' },
    }), 409, 'REVISION_CONFLICT', 'The workspace changed since it was read.', { currentRevision: 2 })
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...update, commandId: randomUUID(), workspaceId: 'workspace-mismatched' },
    }), 400, 'RESOURCE_ID_MISMATCH', "Body field 'workspaceId' must match the URL.")
    await assertProtectedRead(ctx, path, updated)
    await assertProtectedRead(ctx, collectionPath, { items: [updated], pageInfo: { nextCursor: null } })
  },
}
