import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema, RunStartV3InputSchema, RunStartV3ResultSchema,
  makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { ScheduleOperatorCapabilitiesSchema } from '../src/mcp/operator/tools/workflowSchedules.js'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { buildApp } from '../src/app.js'
import { DomainError } from '../src/modules/errors.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { mixedComputerPlacement } from './helpers/mixedComputerPlacement.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

afterEach(() => vi.restoreAllMocks())

function toolError(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).toBe(true)
  const text = result.content.find(item => item.type === 'text')
  if (!text || text.type !== 'text') throw new Error('Expected an MCP error response')
  return JSON.parse(text.text)
}

async function fixture(options: { gitSource?: boolean } = {}) {
  let placementProducer: Awaited<ReturnType<typeof mixedComputerPlacement>>['producer'] | undefined
  const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'),
    admitPlacementExecutionLocked: async (sql, owner, run, execution, ref, inputDigest) => {
      if (!placementProducer) throw new Error('Placement producer is not initialized')
      await placementProducer.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId)
    } })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  let directory: string | undefined
  try {
    directory = await privateFixtureDirectory('mixed-placement-')
    const placement = await mixedComputerPlacement(base, directory, {
      sourceAccessMode: options.gitSource ? 'exclusive-write' : 'read-only',
      git: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), objectFormat: 'sha1', repository: 'octo/site' },
    })
    const workspace = (await base.db.pool.query<{ revision: number }>(
      'select revision from workspaces where id=$1', [base.f.scope.workspaceId])).rows[0]!
    await base.services.workspaces.update(base.writer.principal, 'mcp', {
      workspaceId: base.f.scope.workspaceId, commandId: randomUUID(), expectedRevision: Number(workspace.revision),
      repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
    })
    base.services.workflows = new WorkflowManagementService(base.db.pool, base.commands, {
      worktrees: { readyRoot: async () => undefined, sources: placement.sources, roots: placement.policies },
    })
    placementProducer = placement.producer
    await base.app.close()
    // Start admission and readback are real; this external provider boundary
    // refuses native entry so no remote execution is simulated on Main.
    const connection = base.provider.connection.bind(base.provider)
    vi.spyOn(base.provider, 'connection').mockImplementation(() => ({ ...connection(),
      createSession: async () => { throw new DomainError('NATIVE_EXECUTION_UNAVAILABLE', 'Admission-only fixture', 503) },
    }))
    const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
      reportDispatchFailure: (_id, _code, error) => base.dispatchErrors.push(error),
    })({ primaryPool: base.db.pool, commands: base.commands, runs: base.runs, workflows: base.workflows,
      locations: base.locations, engine: base.engine, nativeExecutions: base.native,
      interactions: base.service, checkpointer: base.checkpointer })
    const runs = new RunManagementService(base.db.pool, base.commands, base.runs, base.engine, base.locations, {
      ...binding, startPublication: { ...binding.startPublication, placementAdmission: placement.producer,
        workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }) },
    })
    const services = { ...base.services, runs, runPlacements: placement.reads }
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: base.access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'mixed-placement', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(base.writer.token)
    const saveInput = await base.create()
    saveInput.expectedLocationRevision = placement.locationRevision
    agentWorkflowNode(saveInput.graph.nodes[1]).placement = placement.remote
    const path = `/api/management/workspaces/${saveInput.workspaceId}/workflows/${saveInput.workflowId}`
    const headers = { authorization: `Bearer ${base.writer.token}` }
    return { base, placement, app, client, connect, saveInput, path, headers,
      async save(via: 'http' | 'mcp') {
        if (via === 'mcp') {
          const result = await client.callTool({ name: 'workflow_save_v3', arguments: saveInput })
          expect(result.isError, JSON.stringify(result)).not.toBe(true)
          return CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(result)).value
        }
        const response = await app!.inject({ method: 'PUT', url: `${path}/definition`, headers, payload: saveInput })
        expect(response.statusCode).toBe(200)
        return CurrentWorkflowSaveResultSchema.parse(response.json()).value
      },
      async start(via: 'http' | 'mcp', input: ReturnType<typeof RunStartV3InputSchema.parse>) {
        if (via === 'mcp') {
          const result = await client.callTool({ name: 'run_start', arguments: input })
          expect(result.isError).not.toBe(true)
          return RunStartV3ResultSchema.parse(decodeMcpToolResult(result))
        }
        const response = await app!.inject({ method: 'POST', url: `${path}/runs`, headers, payload: input })
        expect(response.statusCode).toBe(202)
        return RunStartV3ResultSchema.parse(response.json())
      },
      async close() {
        await Promise.allSettled(clients.map(client => client.close()))
        await app!.close()
        await base.close()
        await rm(directory!, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await base.close()
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
function startInput(f: Fixture, saved: Awaited<ReturnType<Fixture['save']>>) {
  return RunStartV3InputSchema.parse({ workspaceId: saved.version.workspaceId, workflowId: saved.version.workflowId,
    workflowVersionId: saved.currentVersionId, executionSemanticsVersion: 3, commandId: randomUUID(),
    expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: f.placement.locationRevision, input: {} })
}

async function advanceMainSourceBinding(f: Fixture) {
  const rootId = f.placement.local.rootBinding!.rootId
  const row = (await f.base.db.pool.query('select record from source_root_bindings where root_id=$1 and binding_revision=1',
    [rootId])).rows[0]!
  const root = SourceRootRecordSchema.parse(row.record)
  root.binding.bindingRevision = 2
  await f.base.db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,2,$2,$3,$4::jsonb)`, [rootId, f.saveInput.workspaceId, root.source.snapshotId, JSON.stringify(root)])
  await f.base.db.pool.query('update source_root_catalog set current_binding_revision=2 where root_id=$1', [rootId])
}

describe.skipIf(!postgresEnabled)('mixed computer placement admission', () => {
  it('freezes a remote workflow default and a local Agent override through authenticated MCP', async () => {
    const f = await fixture({ gitSource: true })
    try {
      f.saveInput.graph.defaultWorktree = { rootBinding: f.placement.remote.rootBinding!,
        branchPrefix: 'foreman/site/default' }
      const inherited = agentWorkflowNode(f.saveInput.graph.nodes[0])
      const explicit = agentWorkflowNode(f.saveInput.graph.nodes[1])
      explicit.placement = f.placement.local
      explicit.worktree = { branchPrefix: 'foreman/site/reviewer' }
      const saved = await f.save('mcp')
      const accepted = await f.start('mcp', startInput(f, saved))
      const read = async (nodeId: string) => {
        const response = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
          workspaceId: f.saveInput.workspaceId, workflowId: f.saveInput.workflowId,
          runId: accepted.run.id, nodeId,
        } })
        expect(response.isError).not.toBe(true)
        return RunPlacementGetResultSchema.parse(decodeMcpToolResult(response)).readback
      }
      const inheritedRead = await read(inherited.id)
      const explicitRead = await read(explicit.id)
      expect(inheritedRead).toMatchObject({ evidence: 'accepted', placement: {
        labelAtAcceptance: 'Workflow default', hostRef: f.placement.remote.hostRef,
        payload: { instanceId: f.placement.remote.instanceId,
          worktree: { repository: 'octo/site', branch: 'foreman/site/default' } },
      } })
      expect(explicitRead).toMatchObject({ evidence: 'accepted', placement: {
        hostRef: f.placement.local.hostRef, payload: { instanceId: f.placement.local.instanceId,
          worktree: { repository: 'octo/site', branch: 'foreman/site/reviewer' } },
      } })
      const workspace = (await f.base.db.pool.query<{ revision: number }>(
        'select revision from workspaces where id=$1', [f.saveInput.workspaceId])).rows[0]!
      await f.base.services.workspaces.update(f.base.writer.principal, 'mcp', {
        workspaceId: f.saveInput.workspaceId, commandId: randomUUID(), expectedRevision: Number(workspace.revision),
        repository: { provider: 'github', owner: 'changed', name: 'site', defaultBranch: 'main' },
      })
      expect(await read(inherited.id)).toEqual(inheritedRead)
      expect(await read(explicit.id)).toEqual(explicitRead)
    } finally { await f.close() }
  }, 120_000)

  it('clears explicit placement through MCP Save and readback, then resolves inherited Main at Start', async () => {
    const f = await fixture()
    try {
      agentWorkflowNode(f.saveInput.graph.nodes[0]).placement = f.placement.local
      const original = await f.save('mcp')
      const graph = structuredClone(original.version.definition)
      const clearedNode = agentWorkflowNode(graph.nodes[1])
      delete clearedNode.placement
      const input = { ...f.saveInput, commandId: randomUUID(), expectedRevision: original.revision,
        expectedWorkflowVersionId: original.currentVersionId, graph }
      const reader = await f.base.access.issue({ name: 'Placement reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [input.workspaceId], workflowIds: [input.workflowId] } }] })
      const denied = await f.connect(reader.token)
      expect(toolError(await denied.callTool({ name: 'workflow_save_v3', arguments: input })))
        .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const result = await f.client.callTool({ name: 'workflow_save_v3', arguments: input })
      expect(result.isError).not.toBe(true)
      const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(result)).value
      expect(agentWorkflowNode(saved.version.definition.nodes[1])).not.toHaveProperty('placement')
      const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
      const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: scope })
      expect(read.isError).not.toBe(true)
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version).toEqual(saved.version)
      const retry = await f.client.callTool({ name: 'workflow_save_v3', arguments: input })
      expect(CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(retry)))
        .toEqual({ value: saved, replayed: true })
      const historical = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        ...scope, workflowVersionId: original.version.id,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(historical)).version).toEqual(original.version)
      const accepted = await f.start('mcp', startInput(f, saved))
      const placement = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
        ...scope, runId: accepted.run.id, nodeId: clearedNode.id,
      } })
      expect(placement.isError).not.toBe(true)
      expect(RunPlacementGetResultSchema.parse(decodeMcpToolResult(placement)).readback)
        .toMatchObject({ evidence: 'accepted', placement: { labelAtAcceptance: 'Main',
          hostRef: f.placement.local.hostRef } })
    } finally { await f.close() }
  }, 120_000)

  it('starts a fully placed workflow without probing the original workspace directory', async () => {
    const f = await fixture()
    try {
      agentWorkflowNode(f.saveInput.graph.nodes[0]).placement = f.placement.local
      const saved = await f.save('mcp')
      const directory = vi.spyOn(f.base.locations, 'snapshot').mockRejectedValue(
        new DomainError('LOCATION_UNAVAILABLE', 'Workspace directory unavailable.', 409))
      const accepted = await f.start('mcp', startInput(f, saved))
      expect(accepted.run.workflowVersionId).toBe(saved.version.id)
      expect(directory).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)

  it('persists implicit Main placement for an artifact producer through authenticated MCP and denies a reader', async () => {
    const f = await fixture()
    try {
      const node = agentWorkflowNode(f.saveInput.graph.nodes[0])
      node.artifactOutputs = { version: 1, outputKeys: ['report'] }
      f.saveInput.graph.nodes = [node]
      f.saveInput.graph.edges = []
      f.saveInput.expectedAgentConfigurationVersionIds = {
        [node.agentId]: f.saveInput.expectedAgentConfigurationVersionIds[node.agentId]!,
      }
      const saved = await f.save('mcp')
      expect(agentWorkflowNode(saved.version.definition.nodes[0]).placement).toBeUndefined()
      const input = startInput(f, saved)
      const accepted = await f.start('mcp', input)
      const result = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: node.id,
      } })
      expect(result.isError).not.toBe(true)
      const read = RunPlacementGetResultSchema.parse(decodeMcpToolResult(result))
      if (read.readback.evidence !== 'accepted') throw new Error('Accepted Main placement required')
      expect(read.readback.placement.hostRef).toEqual(f.placement.local.hostRef)
      expect(read.readback.placement.payload).toMatchObject({ kind: 'agent', artifactOutputs: node.artifactOutputs })
      expect((await f.base.db.pool.query('select record from run_node_placements where run_id=$1 and node_id=$2',
        [accepted.run.id, node.id])).rows[0]?.record).toEqual(read.readback.placement)
      const reader = await f.base.access.issue({ name: 'Artifact workflow reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: [input.workspaceId], workflowIds: [input.workflowId] } }] })
      const denied = await f.connect(reader.token)
      expect(toolError(await denied.callTool({ name: 'run_start', arguments: { ...input, commandId: randomUUID() } })))
        .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    } finally { await f.close() }
  }, 120_000)
  it.each(['http', 'mcp'] as const)('%s Save and Start persist an unplaced Main Agent and an explicit remote Agent', async via => {
    const f = await fixture()
    let stage = 'save'
    onTestFailed(() => { console.error(`Placement test failed at ${stage}:`, f.base.dispatchErrors) })
    try {
      const saved = await f.save(via)
      const local = agentWorkflowNode(saved.version.definition.nodes[0])
      const remote = agentWorkflowNode(saved.version.definition.nodes[1])
      expect(local.placement).toBeUndefined()
      expect(remote.placement).toEqual(f.placement.remote)
      const input = startInput(f, saved)
      stage = 'start'
      const accepted = await f.start(via, input)
      expect(accepted.accepted).toBe(true)
      expect(accepted.replayed).toBe(false)
      expect(await f.start(via === 'http' ? 'mcp' : 'http', input)).toEqual({ ...accepted, replayed: true })
      const expected = [f.placement.local, f.placement.remote]
      stage = 'placement readback'
      const readbacks: AcceptedNodePlacement[] = []
      for (const [index, node] of [local, remote].entries()) {
        const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: node.id }
        const response = await f.app.inject({ method: 'GET', headers: f.headers,
          url: `${f.path}/runs/${scope.runId}/nodes/${node.id}/placement` })
        expect(response.statusCode).toBe(200)
        const read = RunPlacementGetResultSchema.parse(response.json())
        const tool = await f.client.callTool({ name: 'run_node_placement_get', arguments: scope })
        expect(tool.isError).not.toBe(true)
        expect(RunPlacementGetResultSchema.parse(decodeMcpToolResult(tool))).toEqual(read)
        if (read.readback.evidence !== 'accepted') throw new Error('Expected accepted placement')
        const pin = read.readback.placement
        if (index === 0) expect(pin.labelAtAcceptance).toBe('Main')
        expect(pin.hostRef).toEqual(expected[index]!.hostRef)
        expect(pin.destination.canonicalProjectRoot).toBe(expected[index]!.projectRoot)
        expect(pin.source).toMatchObject({ kind: 'pending', ...f.placement.source,
          rootId: expected[index]!.rootBinding!.rootId, bindingRevision: 1 })
        expect(pin.payload).toMatchObject({ kind: 'agent', agentId: node.agentId,
          agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId],
          instanceId: expected[index]!.instanceId, instanceRevision: '1', harnessInstallationId: expected[index]!.harnessInstallationId })
        readbacks.push(pin)
      }
      expect((await f.base.db.pool.query('select record from run_node_placements where run_id=$1 order by node_id',
        [accepted.run.id])).rows.map(row => row.record)).toEqual([...readbacks].sort((a, b) => a.nodeId.localeCompare(b.nodeId)))
      await advanceMainSourceBinding(f)
      stage = 'retained readback and retry'
      const retained = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: local.id,
      } })
      expect(RunPlacementGetResultSchema.parse(decodeMcpToolResult(retained)).readback)
        .toMatchObject({ evidence: 'accepted', placement: readbacks[0] })
      expect(await f.start(via, input)).toEqual({ ...accepted, replayed: true })
      const reader = await f.base.access.issue({ name: 'Foreign workflow reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read', 'workspace_locations:read'],
          scope: { workspaceIds: [input.workspaceId], workflowIds: ['another-workflow'] } }] })
      const denied = await f.connect(reader.token)
      stage = 'denied caller'
      expect(toolError(await denied.callTool({ name: 'run_start', arguments: { ...input, commandId: randomUUID() } })))
        .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(toolError(await denied.callTool({ name: 'run_node_placement_get', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: local.id,
      } }))).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect((await f.app.inject({ method: 'POST', url: `${f.path}/runs`,
        headers: { authorization: `Bearer ${reader.token}` }, payload: { ...input, commandId: randomUUID() } })).statusCode).toBe(403)
      expect((await f.app.inject({ method: 'GET', url: `${f.path}/runs/${accepted.run.id}/nodes/${local.id}/placement`,
        headers: { authorization: `Bearer ${reader.token}` } })).statusCode).toBe(403)
      const capabilities = await f.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full',
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id,
      } })
      expect(capabilities.isError).not.toBe(true)
      expect(ScheduleOperatorCapabilitiesSchema.parse(decodeMcpToolResult(capabilities)).tools).toContain('run_node_placement_get')
      const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version).toEqual(saved.version)
      expect(f.base.provider.counts.sessions).toBe(0)
      stage = 'close'
    } finally { await f.close() }
  }, 120_000)

  it.each(['source', 'rootBinding'] as const)('rejects saving remote placement missing %s without a Main fallback', async field => {
    const f = await fixture()
    try {
      delete agentWorkflowNode(f.saveInput.graph.nodes[1]).placement![field]
      const http = await f.app.inject({ method: 'PUT', url: `${f.path}/definition`, headers: f.headers, payload: f.saveInput })
      expect(http.statusCode).toBe(409)
      expect(http.json()).toMatchObject({ error: { code: 'WORKTREE_BINDING_REQUIRED' } })
      expect(toolError(await f.client.callTool({ name: 'workflow_save_v3', arguments: f.saveInput })))
        .toMatchObject({ error: { code: 'WORKTREE_BINDING_REQUIRED' } })
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [f.saveInput.workflowId])).rows).toEqual([])
      expect((await f.base.db.pool.query('select id from workflow_versions where workflow_id=$1', [f.saveInput.workflowId])).rows).toEqual([])
      expect(f.base.provider.counts.sessions).toBe(0)
    } finally { await f.close() }
  }, 120_000)

  it('rejects a Main source binding that changes between resolution and admission commit', async () => {
    const f = await fixture()
    try {
      const saved = await f.save('mcp')
      const prepare = f.placement.producer.prepare.bind(f.placement.producer)
      vi.spyOn(f.placement.producer, 'prepare').mockImplementation(async (...args) => {
        const result = await prepare(...args)
        await advanceMainSourceBinding(f)
        return result
      })
      const input = startInput(f, saved)
      expect(toolError(await f.client.callTool({ name: 'run_start', arguments: input })))
        .toMatchObject({ error: { code: 'PLACEMENT_ADMISSION_CONFLICT' } })
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
      expect((await f.base.db.pool.query('select 1 from run_node_placements p join runs r on r.id=p.run_id where r.workflow_id=$1',
        [input.workflowId])).rows).toEqual([])
    } finally { await f.close() }
  }, 120_000)

  it.each(['source-permission', 'qualification'] as const)('preserves the Main %s gate for implicit placement', async gate => {
    const f = await fixture()
    try {
      const saved = await f.save('mcp')
      let caller = f.client
      if (gate === 'source-permission') {
        const limited = await f.base.access.issue({ name: 'Starter without source access', audience: 'operator',
          expiresAt: new Date(Date.now() + 60_000), grants: [{
            actions: ['runs:start', 'workspace_locations:read', 'source_roots:read'],
            scope: { workspaceIds: [saved.version.workspaceId] },
          }] })
        caller = await f.connect(limited.token)
      } else {
        await f.base.db.pool.query("update harness_qualifications set status='failed' where harness='codex'")
      }
      const input = startInput(f, saved)
      const result = toolError(await caller.callTool({ name: 'run_start', arguments: input }))
      expect(result).toMatchObject({ error: {
        code: gate === 'source-permission' ? 'ACCESS_DENIED' : 'HARNESS_PROFILE_UNAVAILABLE',
      } })
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
      expect(f.base.provider.counts.sessions).toBe(0)
    } finally { await f.close() }
  }, 120_000)
})
