import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  WorkspaceBoundLocationBrowseResultSchema, WorkspaceBoundLocationReadbackSchema,
  WorkspaceRootConfigurationAdoptSchema, WorkspaceRootConfigurationAdoptResultSchema,
} from '@foreman-code/contracts/workspace-bound-location'
import { WORKSPACE_ROOT_EXTENSION, WorkspaceRootSelectionSchema,
  type WorkspaceRootWorkerRequest } from '@foreman-code/contracts/workspace-root-policies'
import { assertJson, assertResponse } from '../../assertions.js'
import { connectTestWorker, type TestWorkerClient } from '../../clients/workerConnection.js'
import { pairTestWorker } from '../../clients/workerPairing.js'
import { createTestWorkerRoots } from '../../clients/workerRoots.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertInvalidCallerDenied, assertReadOnlyDenied, assertToolFailure,
  callTool, mcpClaims, operatorClients } from './support.js'
import { createMcpWorkspace } from './workspaces.js'

async function isolatedRootWorker(context: ScenarioContext) {
  assert.ok(context.target.deviceEndpoint, 'The target must expose its fresh TLS device listener.')
  assert.ok(context.target.deviceTlsTrust, 'The worker needs the fresh listener’s verified CA.')
  const paired = await pairTestWorker({ baseUrl: context.target.baseUrl,
    deviceEndpoint: context.target.deviceEndpoint, deviceTlsTrust: context.target.deviceTlsTrust,
    appVersion: context.target.applicationVersion, signal: context.signal,
    managementRequest: (method, path, body) => context.http.request(method, path, { body }),
  })
  const roots = await createTestWorkerRoots(context.target.directory, paired.pairing)
  const connect = () => connectTestWorker({ pairing: paired.pairing, appVersion: context.target.applicationVersion,
    extensions: [roots.extension], signal: context.signal })
  return { paired, roots, connect, worker: await connect() }
}

async function assertNativeRootRequest(worker: TestWorkerClient, expected: WorkspaceRootWorkerRequest) {
  const operation = await worker.waitForOperation(value => value.namespace === WORKSPACE_ROOT_EXTENSION.namespace
    && isDeepStrictEqual(value.payload, expected))
  const { signal, ...wire } = operation
  assert.ok(signal instanceof AbortSignal)
  assertJson(wire, { id: '<uuid>', namespace: WORKSPACE_ROOT_EXTENSION.namespace,
    payload: expected, binding: worker.currentBinding() }, [{ pointer: '/body/id', kind: 'uuid' }])
}

function expectedBrowse(selection: ReturnType<typeof WorkspaceRootSelectionSchema.parse>, names: string[]) {
  return { workspaceId: selection.workspaceId, selection, browse: { relativePath: selection.relativePath,
    directories: names.map(name => ({ name, relativePath: selection.relativePath ? `${selection.relativePath}/${name}` : name })),
    truncated: false } }
}

const rootBase = '/api/management/workspaces/:workspaceId'

export const workerRootMcpScenarios: Scenario[] = [{
  id: 'mcp.worker-roots.remote-browse',
  title: 'MCP adopts freshly paired managed storage and reads real directories across Worker reconnect and Main restart',
  lane: 'R', authentication: 'operator', timeoutMs: 120_000,
  covers: [
    ...mcpClaims('workspace_root_configuration_adopt', 'workspace_root_directories_list', 'workspace_root_location_get'),
    { surface: 'http', method: 'POST', path: `${rootBase}/root-configurations/adopt`, case: 'success' },
    { surface: 'http', method: 'GET', path: `${rootBase}/root-location`, case: 'success' },
    { surface: 'http', method: 'POST', path: `${rootBase}/root-location/browse`, case: 'success' },
    { surface: 'http', method: 'POST', path: `${rootBase}/root-location/browse`, case: 'error' },
  ],
  async run(context) {
    const { operator, readOnly } = operatorClients(context)
    const fixture = await isolatedRootWorker(context)
    let worker = fixture.worker
    try {
      const { roots } = fixture
      await mkdir(join(roots.workspaceDirectory, 'alpha'), { mode: 0o700 })
      await mkdir(join(roots.workspaceDirectory, 'alpha', 'nested'), { mode: 0o755 })
      await mkdir(join(roots.workspaceDirectory, 'zeta'), { mode: 0o700 })
      await writeFile(join(roots.workspaceDirectory, 'readme.txt'), 'Owned worker fixture bytes.\n', { flag: 'wx', mode: 0o600 })
      await symlink('alpha', join(roots.workspaceDirectory, 'alpha-link'), 'dir')
      const { result } = await createMcpWorkspace(operator, 'Remote managed directory browse')
      const workspaceId = result.value.workspace.id
      const path = `/api/management/workspaces/${workspaceId}`
      const headers = { token: context.target.operatorToken! }
      const unconfigured = { evidence: 'unconfigured', workspaceId, locationRevision: 0, executionLocation: null }
      assertJson(await callTool(operator, 'workspace_root_location_get', { workspaceId }, WorkspaceBoundLocationReadbackSchema), unconfigured)
      await assertInvalidCallerDenied(operator, 'workspace_root_location_get', { workspaceId })
      const adopt = WorkspaceRootConfigurationAdoptSchema.parse({ commandId: randomUUID(), workspaceId,
        hostRef: roots.configuration.hostRef })
      await assertReadOnlyDenied(readOnly, 'workspace_root_configuration_adopt', adopt)
      const adopted = await callTool(operator, 'workspace_root_configuration_adopt', adopt, WorkspaceRootConfigurationAdoptResultSchema)
      assertJson(adopted, { value: roots.configuration, replayed: false })
      await assertNativeRootRequest(worker, { version: 1, operation: 'workspace-roots.configuration' })
      const selection = WorkspaceRootSelectionSchema.parse({ workspaceId, hostRef: roots.configuration.hostRef,
        allowedBaseId: roots.configuration.bases[0]!.baseId, configurationRevision: '1', relativePath: '',
        accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 })
      await assertInvalidCallerDenied(operator, 'workspace_root_directories_list', selection)
      const first = expectedBrowse(selection, ['alpha', 'zeta'])
      assertJson(await callTool(operator, 'workspace_root_directories_list', selection, WorkspaceBoundLocationBrowseResultSchema), first)
      await assertNativeRootRequest(worker, { version: 1, operation: 'workspace-roots.browse', selection, relativePath: '' })
      const nested = { ...selection, relativePath: 'alpha' }
      assertJson(await callTool(operator, 'workspace_root_directories_list', nested, WorkspaceBoundLocationBrowseResultSchema),
        expectedBrowse(nested, ['nested']))
      await assertNativeRootRequest(worker, { version: 1, operation: 'workspace-roots.browse', selection: nested, relativePath: 'alpha' })
      const leaf = { ...selection, relativePath: 'alpha/nested' }
      assertJson(await callTool(operator, 'workspace_root_directories_list', leaf, WorkspaceBoundLocationBrowseResultSchema),
        expectedBrowse(leaf, []))
      await assertNativeRootRequest(worker, { version: 1, operation: 'workspace-roots.browse', selection: leaf, relativePath: 'alpha/nested' })
      const invalid = { ...selection, relativePath: '..' }
      const invalidError = { code: 'ROOT_RELATIVE_PATH_INVALID',
        message: 'Choose an unambiguous folder relative to an approved base.' }
      assertToolFailure(await operator.callTool('workspace_root_directories_list', invalid), invalidError)
      assertResponse(await context.http.request('POST', `${path}/root-location/browse`, { ...headers, body: invalid }), {
        status: 422, body: { error: { ...invalidError, requestId: '<uuid>' } },
      }, [{ pointer: '/body/error/requestId', kind: 'uuid' }])
      // This change must be visible through the next real remote operation, not a canned fixture response.
      await mkdir(join(roots.workspaceDirectory, 'beta'), { mode: 0o700 })
      const changed = expectedBrowse(selection, ['alpha', 'beta', 'zeta'])
      assertResponse(await context.http.request('POST', `${path}/root-location/browse`, { ...headers, body: selection }), {
        status: 200, body: changed,
      })
      await worker.close()
      await context.target.restart()
      worker = await fixture.connect()
      assertJson(await callTool(operator, 'workspace_root_configuration_adopt', adopt, WorkspaceRootConfigurationAdoptResultSchema), {
        value: roots.configuration, replayed: true,
      })
      assertResponse(await context.http.request('POST', `${path}/root-configurations/adopt`, { ...headers, body: adopt }), {
        status: 200, body: { value: roots.configuration, replayed: true },
      })
      assertJson(await callTool(operator, 'workspace_root_directories_list', selection, WorkspaceBoundLocationBrowseResultSchema), changed)
      await assertNativeRootRequest(worker, { version: 1, operation: 'workspace-roots.browse', selection, relativePath: '' })
      assertJson(await callTool(operator, 'workspace_root_location_get', { workspaceId }, WorkspaceBoundLocationReadbackSchema), unconfigured)
      assertResponse(await context.http.request('GET', `${path}/root-location`, headers), { status: 200, body: unconfigured })
    } finally { await worker.close() }
  },
}]
