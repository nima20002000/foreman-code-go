import { randomUUID } from 'node:crypto'
import {
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  ManagedGeneralSettingsSchema,
  ManagedWorkspaceCommandResultSchema,
  WorkspaceUpdateInputSchema,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage, readWorkspace } from './support.js'

const workspacesPath = '/api/management/workspaces'
const workspacePath = `${workspacesPath}/:workspaceId`
const settingsPath = '/api/management/settings/general'

export const workspaceScenarios: Scenario[] = [
  {
    id: 'workspace.create-replay-read', title: 'Workspace creation replays its receipt and persists its exact record', lane: 'A2',
    covers: [httpCoverage('POST', workspacesPath, 'success'), httpCoverage('GET', workspacePath, 'success')],
    async run(ctx) {
      const { input, created } = await createWorkspace(ctx, 'Conformance workspace receipt')
      const replay = await ctx.http.request('POST', workspacesPath, { body: input })
      ManagedWorkspaceCommandResultSchema.parse(replay.body)
      assertResponse(replay, { status: 200, body: { value: created, replayed: true } })
      await readWorkspace(ctx, created)
    },
  },
  {
    id: 'workspace.update-revision-conflict', title: 'Workspace updates advance revision and reject a stale writer', lane: 'A2',
    covers: [httpCoverage('PATCH', workspacePath, 'success'), httpCoverage('PATCH', workspacePath, 'error')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance workspace revision')
      const path = `${workspacesPath}/${created.workspace.id}`
      const input = WorkspaceUpdateInputSchema.parse({
        workspaceId: created.workspace.id, commandId: randomUUID(), expectedRevision: created.revision,
        name: 'Conformance workspace renamed', description: null,
      })
      const response = await ctx.http.request('PATCH', path, { body: input })
      const updated = ManagedWorkspaceCommandResultSchema.parse(response.body)
      assertResponse(response, {
        status: 200,
        body: {
          value: {
            ...created,
            workspace: {
              id: created.workspace.id, name: input.name,
              createdAt: created.workspace.createdAt, updatedAt: '<timestamp>',
            },
            revision: created.revision + 1, locationValidation: { status: 'unconfigured' },
          },
          replayed: false,
        },
      }, [{ pointer: '/body/value/workspace/updatedAt', kind: 'timestamp' }])
      const conflict = await ctx.http.request('PATCH', path, {
        body: { ...input, commandId: randomUUID(), name: 'Stale replacement' },
      })
      assertApiError(conflict, 409, 'REVISION_CONFLICT', 'The workspace changed since it was read.', {
        currentRevision: created.revision + 1,
      })
      await readWorkspace(ctx, updated.value)
    },
  },
  {
    id: 'settings.general-replay-read', title: 'General settings writes persist and replay without advancing twice', lane: 'A2',
    covers: [httpCoverage('PUT', settingsPath, 'success'), httpCoverage('GET', settingsPath, 'success'),
      httpCoverage('PUT', settingsPath, 'error')],
    async run(ctx) {
      const before = await ctx.http.request('GET', settingsPath)
      const current = ManagedGeneralSettingsSchema.parse(before.body)
      assertResponse(before, { status: 200, body: { value: { theme: 'dark' }, revision: 0, versionId: null } })
      const input = GeneralSettingsUpdateInputSchema.parse({
        commandId: randomUUID(), expectedRevision: current.revision, value: { theme: 'light' },
      })
      const response = await ctx.http.request('PUT', settingsPath, { body: input })
      const updated = GeneralSettingsUpdateResultSchema.parse(response.body)
      assertResponse(response, {
        status: 200,
        body: { value: { value: { theme: 'light' }, revision: current.revision + 1, versionId: '<id>' }, replayed: false },
      }, [{ pointer: '/body/value/versionId', kind: 'id' }])
      const replay = await ctx.http.request('PUT', settingsPath, { body: input })
      assertResponse(replay, { status: 200, body: { value: updated.value, replayed: true } })
      const stale = await ctx.http.request('PUT', settingsPath, {
        body: { ...input, commandId: randomUUID(), value: { theme: 'dark' } },
      })
      assertApiError(stale, 409, 'REVISION_CONFLICT', 'Defaults changed since they were read.', {
        currentRevision: current.revision + 1,
      })
      assertResponse(await ctx.http.request('GET', settingsPath), { status: 200, body: updated.value })
    },
  },
]
