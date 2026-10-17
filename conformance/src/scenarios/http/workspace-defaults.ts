import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_WORKSPACE_DEFAULTS,
  ManagedWorkspaceCommandResultSchema,
  WorkspaceCreateInputSchema,
  WorkspaceDefaultsSchema,
  WorkspaceDefaultsUpdateInputSchema,
  WorkspaceDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, httpCoverage, readWorkspace } from '../smoke/support.js'
import { assertProtectedRead, readCoverage } from './support.js'

const settingsPath = '/api/management/settings/workspaces'
const creationPath = `${settingsPath}/creation`

async function createSuggestedWorkspace(ctx: ScenarioContext, name: string, description: string) {
  const input = WorkspaceCreateInputSchema.parse({ commandId: randomUUID() })
  const response = await ctx.http.request('POST', '/api/management/workspaces', { body: input })
  const created = ManagedWorkspaceCommandResultSchema.parse(response.body).value
  assertResponse(response, {
    status: 201,
    body: {
      value: {
        workspace: { id: '<id>', name, description, createdAt: '<timestamp>', updatedAt: '<timestamp>' },
        revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0,
        locationValidation: { status: 'restricted' },
      },
      replayed: false,
    },
  }, [
    { pointer: '/body/value/workspace/id', kind: 'id' },
    { pointer: '/body/value/workspace/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/workspace/updatedAt', kind: 'timestamp' },
  ])
  assert.equal(created.workspace.createdAt, created.workspace.updatedAt)
  await readWorkspace(ctx, created)
}

export const workspaceDefaultsScenario: Scenario = {
  id: 'http.settings.workspace-defaults',
  title: 'Workspace suggestions round trip and supply unique names without granting a location',
  lane: 'A2',
  covers: [
    ...readCoverage(settingsPath),
    ...readCoverage(creationPath),
    httpCoverage('PUT', settingsPath, 'success'),
    httpCoverage('PUT', settingsPath, 'error'),
  ],
  async run(ctx) {
    const parentPath = ctx.target.environment.WORKSPACE_STORAGE_ROOT
    assert.ok(parentPath, 'The launcher must supply its owned workspace storage root')
    const initialValue = WorkspaceDefaultsSchema.parse({ ...DEFAULT_WORKSPACE_DEFAULTS, parentPath })
    await assertProtectedRead(ctx, settingsPath, { value: initialValue, revision: 0, versionId: null })
    await assertProtectedRead(ctx, creationPath, initialValue)

    const value = WorkspaceDefaultsSchema.parse({
      suggestedName: 'Conformance suggested workspace', description: 'Inherited creation description.',
    })
    const input = WorkspaceDefaultsUpdateInputSchema.parse({
      value, commandId: randomUUID(), expectedRevision: 0,
    })
    const response = await ctx.http.request('PUT', settingsPath, { body: input })
    const saved = WorkspaceDefaultsUpdateResultSchema.parse(response.body).value
    assertResponse(response, {
      status: 200, body: { value: { value, revision: 1, versionId: '<id>' }, replayed: false },
    }, [{ pointer: '/body/value/versionId', kind: 'id' }])
    assertResponse(await ctx.http.request('PUT', settingsPath, { body: input }), {
      status: 200, body: { value: saved, replayed: true },
    })
    assertApiError(await ctx.http.request('PUT', settingsPath, {
      body: { ...input, commandId: randomUUID(), value: DEFAULT_WORKSPACE_DEFAULTS },
    }), 409, 'REVISION_CONFLICT', 'Defaults changed since they were read.', { currentRevision: 1 })
    const creationValue = { ...value, parentPath }
    await assertProtectedRead(ctx, settingsPath, { ...saved, value: creationValue })
    await assertProtectedRead(ctx, creationPath, creationValue)
    await createSuggestedWorkspace(ctx, value.suggestedName, value.description)
    await createSuggestedWorkspace(ctx, `${value.suggestedName} (1)`, value.description)
    await ctx.target.restart()
    await assertProtectedRead(ctx, settingsPath, { ...saved, value: creationValue })
  },
}
