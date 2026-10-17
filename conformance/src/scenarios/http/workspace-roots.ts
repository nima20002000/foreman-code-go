import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  WorkspaceRootListResultSchema,
  WorkspaceRootSelectionSchema,
  type ApprovedRootAllowlist,
  type WorkspaceRootPolicy,
  type WorkspaceRootSelection,
} from '@foreman-code/contracts/workspace-root-policies'
import {
  WorkspaceBoundLocationBrowseResultSchema,
  WorkspaceBoundLocationReadbackSchema,
  WorkspaceRootConfigurationAdoptSchema,
  type WorkspaceBoundLocationReadback,
} from '@foreman-code/contracts/workspace-bound-location'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { mainRootConfiguration, readMainIdentity } from './main-roots.js'
import { ownedFilesystem } from './owned-filesystem.js'
import { assertProtectedRead, readCoverage } from './support.js'
import { assertRootValidation, bindMainRoot, type WorkspaceRootFixture } from './workspace-root-assertions.js'

const workspaceRoute = '/api/management/workspaces/:workspaceId'

async function createRootFixture(ctx: ScenarioContext, workspaceId: string,
  configuration: ApprovedRootAllowlist): Promise<WorkspaceRootFixture> {
  const base = configuration.bases[0]
  assert.ok(base)
  const relativePath = 'conformance-project'
  const directory = join(base.canonicalPath, relativePath)
  await mkdir(directory, { mode: 0o700 })
  await mkdir(join(directory, 'notes'), { mode: 0o700 })
  await mkdir(join(directory, 'source'), { mode: 0o700 })
  await writeFile(join(directory, 'readme.txt'), 'Owned conformance workspace fixture.\n', { mode: 0o600, flag: 'wx' })
  const selection = WorkspaceRootSelectionSchema.parse({
    workspaceId, hostRef: configuration.hostRef, allowedBaseId: base.baseId,
    configurationRevision: configuration.configurationRevision, relativePath, accessMode: 'read-only',
    expectedLocationRevision: 0, expectedRootPolicyRevision: 0,
  })
  const { filesystem } = await ownedFilesystem(ctx, directory)
  return { configuration, selection, filesystem }
}

async function readRootState(ctx: ScenarioContext, path: string, configuration: ApprovedRootAllowlist,
  location: WorkspaceBoundLocationReadback, policies: WorkspaceRootPolicy[]) {
  const choices = WorkspaceRootListResultSchema.parse({
    workspaceId: location.workspaceId, policies, allowlists: [configuration], readiness: 'metadata-only',
  })
  await assertProtectedRead(ctx, `${path}/root-policies`, choices)
  await assertProtectedRead(ctx, `${path}/root-location`, location)
}

async function adoptMainConfiguration(ctx: ScenarioContext, path: string, workspaceId: string,
  configuration: ApprovedRootAllowlist) {
  const input = WorkspaceRootConfigurationAdoptSchema.parse({
    workspaceId, commandId: randomUUID(), hostRef: configuration.hostRef,
  })
  assertResponse(await ctx.http.request('POST', path, { body: input }), {
    status: 200, body: { value: configuration, replayed: false },
  })
  assertResponse(await ctx.http.request('POST', path, { body: input }), {
    status: 200, body: { value: configuration, replayed: true },
  })
  assertApiError(await ctx.http.request('POST', path, { body: {
    ...input, commandId: randomUUID(), hostRef: { kind: 'main', mainId: randomUUID() },
  } }), 403, 'ROOT_WRONG_MAIN', 'Select a host on this Main installation.')
}

async function browseRoot(ctx: ScenarioContext, path: string, selection: WorkspaceRootSelection) {
  const body = WorkspaceBoundLocationBrowseResultSchema.parse({
    workspaceId: selection.workspaceId, selection,
    browse: { relativePath: selection.relativePath, directories: [
      { name: 'notes', relativePath: `${selection.relativePath}/notes` },
      { name: 'source', relativePath: `${selection.relativePath}/source` },
    ], truncated: false },
  })
  assertResponse(await ctx.http.request('POST', path, { body: selection }), { status: 200, body })
}

async function rejectRootSelections(ctx: ScenarioContext, path: string, selection: WorkspaceRootSelection) {
  for (const action of ['browse', 'validate']) {
    assertApiError(await ctx.http.request('POST', `${path}/${action}`, {
      body: { ...selection, relativePath: '../outside' },
    }), 422, 'ROOT_RELATIVE_PATH_INVALID', 'Choose an unambiguous folder relative to an approved base.')
    assertApiError(await ctx.http.request('POST', `${path}/${action}`, {
      body: { ...selection, relativePath: `${selection.relativePath}/missing` },
    }), 409, 'ROOT_DIRECTORY_MISSING', 'The selected folder does not exist on this computer.')
    assertApiError(await ctx.http.request('POST', `${path}/${action}`, {
      body: { ...selection, allowedBaseId: randomUUID() },
    }), 403, 'ROOT_ACCESS_DENIED', 'Select an allowed base/access mode from the current human-approved host configuration.')
  }
}

async function rejectStaleBinding(ctx: ScenarioContext, path: string, selection: WorkspaceRootSelection) {
  assertApiError(await ctx.http.request('PUT', path, { body: { ...selection, commandId: randomUUID() } }),
    409, 'LOCATION_REVISION_CONFLICT', 'The workspace location changed since it was selected.')
  assertApiError(await ctx.http.request('PUT', path, { body: {
    ...selection, commandId: randomUUID(), expectedLocationRevision: 1,
  } }), 409, 'ROOT_POLICY_REVISION_CONFLICT', 'The selected host root policy changed.', { currentRootPolicyRevision: 1 })
}

export const workspaceRootsScenario: Scenario = {
  id: 'http.workspace-roots.main',
  title: 'Main roots adopt existing configuration and persist an attested read-only workspace binding',
  lane: 'S',
  authentication: 'local-human',
  covers: [
    ...readCoverage(`${workspaceRoute}/root-policies`),
    ...readCoverage(`${workspaceRoute}/root-location`),
    ...(['success', 'error'] as const).flatMap(outcome => [
      httpCoverage('POST', `${workspaceRoute}/root-configurations/adopt`, outcome),
      httpCoverage('POST', `${workspaceRoute}/root-location/validate`, outcome),
      httpCoverage('POST', `${workspaceRoute}/root-location/browse`, outcome),
      httpCoverage('PUT', `${workspaceRoute}/root-location`, outcome),
    ]),
  ],
  async run(ctx) {
    const { created } = await createWorkspace(ctx, 'Conformance Main root')
    const workspaceId = created.workspace.id
    const path = `/api/management/workspaces/${workspaceId}`
    const main = await readMainIdentity(ctx)
    const configuration = await mainRootConfiguration(ctx, main.mainId)
    const unconfigured = WorkspaceBoundLocationReadbackSchema.parse({
      evidence: 'unconfigured', workspaceId, locationRevision: 0, executionLocation: null,
    })
    await readRootState(ctx, path, configuration, unconfigured, [])
    await adoptMainConfiguration(ctx, `${path}/root-configurations/adopt`, workspaceId, configuration)
    const fixture = await createRootFixture(ctx, workspaceId, configuration)
    await browseRoot(ctx, `${path}/root-location/browse`, fixture.selection)
    const validation = await assertRootValidation(ctx, `${path}/root-location/validate`, fixture)
    await rejectRootSelections(ctx, `${path}/root-location`, fixture.selection)
    await readRootState(ctx, path, configuration, unconfigured, [])

    const { input, bound } = await bindMainRoot(ctx, `${path}/root-location`, fixture)
    assert.notEqual(bound.binding.attestationId, validation.attestationId)
    await rejectStaleBinding(ctx, `${path}/root-location`, fixture.selection)
    await readRootState(ctx, path, configuration, bound, [bound.binding])
    await ctx.target.restart()
    await readRootState(ctx, path, configuration, bound, [bound.binding])
    assertResponse(await ctx.http.request('PUT', `${path}/root-location`, { body: input }), {
      status: 200, body: { value: bound, replayed: true },
    })
  },
}
