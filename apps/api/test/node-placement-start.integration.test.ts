import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavedNodePlacement } from '@graphql/contracts/node-placement'
import {
  CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema, RunStartV3InputSchema,
  makeCurrentWorkflowFixture,
} from '@graphql/contracts/wave25'
import { AgentPlacementProducer } from '../src/modules/placement/agentProducer.js'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import { HarnessInstanceRegistry } from '../src/modules/harnesses/instanceRegistry.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import type { SourceAdmissionPort } from '../src/modules/sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../src/modules/sources/rootPolicyPorts.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

afterEach(() => vi.restoreAllMocks())

function placement(mainId: string, deviceId?: string): SavedNodePlacement {
  return {
    schemaVersion: 1,
    hostRef: deviceId ? { kind: 'device', mainId, deviceId } : { kind: 'main', mainId },
    rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1',
    projectRoot: '/approved/project', cwdPolicy: 'project-root', relativeCwd: '',
    instanceId: randomUUID(), instanceRevision: '1', harnessInstallationId: 'installed-codex',
    source: { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'a'.repeat(64) },
    rootBinding: { rootId: randomUUID(), bindingRevision: 1 },
  }
}

function toolError(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).toBe(true)
  const text = result.content.find(item => item.type === 'text')
  if (!text || text.type !== 'text') throw new Error('Expected an MCP error response')
  return JSON.parse(text.text)
}

/** Real Save, immutable readback, Start service, database and authenticated MCP.
 * Incomplete placement is rejected before source authorization or native IO;
 * the unused authority ports do not fabricate a source/root or a device grant. */
describe.skipIf(!postgresEnabled)('mixed computer placement Start guidance', () => {
  it.each(['unplaced', 'missing-source', 'missing-root'] as const)(
    'identifies the %s Main Agent after Save through HTTP and MCP without admitting a Run', async incomplete => {
      const f = await currentOperatorIntegration({
        fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'), approvalNodeIds: [],
      })
      try {
        const mainId = randomUUID()
        const resolveRootBinding = vi.fn<SourceAdmissionPort['resolveRootBinding']>(async () => {
          throw new Error('Incomplete placement must be reported before resolving any source')
        })
        const producer = new AgentPlacementProducer(f.db.pool, mainId,
          { resolveRootBinding } as unknown as SourceAdmissionPort,
          {} as WorkspaceRootPolicyPort,
          new HarnessInstallationRegistry(new HarnessInstanceRegistry([])),
          { codex: 'codex-live-4', opencode: 'opencode-live-4' },
          new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
        const binding = createCurrentNativeProductionFactory({
          isRuntimeOpen: () => true,
          reportDispatchFailure: (_id, code) => f.dispatchErrors.push(code),
        })({ primaryPool: f.db.pool, commands: f.commands, runs: f.runs, workflows: f.workflows,
          locations: f.locations, engine: f.engine, nativeExecutions: f.native,
          interactions: f.service, checkpointer: f.checkpointer })
        await f.services.runs.stopScheduleDispatcher()
        f.services.runs = new RunManagementService(f.db.pool, f.commands, f.runs, f.engine, f.locations, {
          ...binding, startPublication: { ...binding.startPublication, placementAdmission: producer },
        })

        const saveInput = await f.create()
        const local = agentWorkflowNode(saveInput.graph.nodes[0])
        const remote = agentWorkflowNode(saveInput.graph.nodes[1])
        remote.placement = placement(mainId, randomUUID())
        if (incomplete !== 'unplaced') {
          local.placement = placement(mainId)
          if (incomplete === 'missing-source') delete local.placement.source
          if (incomplete === 'missing-root') delete local.placement.rootBinding
        }
        const saveHttp = await f.app.inject({ method: 'PUT',
          url: `/api/management/workspaces/${saveInput.workspaceId}/workflows/${saveInput.workflowId}/definition`,
          headers: { authorization: `Bearer ${f.writer.token}` }, payload: saveInput })
        expect(saveHttp.statusCode).toBe(200)
        const saved = CurrentWorkflowSaveResultSchema.parse(saveHttp.json())
        const saveMcp = await f.client.callTool({ name: 'workflow_save_v3', arguments: saveInput })
        expect(saveMcp.isError).not.toBe(true)
        expect(CurrentWorkflowSaveResultSchema.parse(saveMcp.structuredContent))
          .toEqual({ ...saved, replayed: true })
        const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
          workspaceId: saveInput.workspaceId, workflowId: saveInput.workflowId,
        } })
        expect(read.isError).not.toBe(true)
        expect(CurrentWorkflowReadResultSchema.parse(read.structuredContent).version.definition.nodes)
          .toEqual(saved.value.version.definition.nodes)

        const input = RunStartV3InputSchema.parse({
          workspaceId: saveInput.workspaceId, workflowId: saveInput.workflowId,
          workflowVersionId: saved.value.currentVersionId, executionSemanticsVersion: 3,
          commandId: randomUUID(), expectedWorkflowRevision: saved.value.revision,
          expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds,
          expectedLocationRevision: 1, input: {},
        })
        const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`
        const http = await f.app.inject({ method: 'POST', url: path,
          headers: { authorization: `Bearer ${f.writer.token}` }, payload: input })
        expect(http.statusCode).toBe(409)
        expect(http.json()).toMatchObject({ error: {
          code: 'PLACEMENT_ADMISSION_CONFLICT', details: { nodeIds: [local.id] },
        } })
        expect(http.json().error.message).toContain('including Agents on Main')
        const mcp = await f.client.callTool({ name: 'run_start',
          arguments: { ...input, commandId: randomUUID() } })
        expect(http.json().error.requestId).toEqual(expect.any(String))
        expect(toolError(mcp)).toEqual({ error: {
          code: http.json().error.code, message: http.json().error.message, details: http.json().error.details,
        } })

        const reader = await f.access.issue({ name: 'Placement reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 60_000), grants: [{
            actions: ['runs:read', 'workflows:read', 'graph:read', 'workspace_locations:read'],
            scope: { workspaceIds: [input.workspaceId] },
          }] })
        const denied = await f.connect(reader.token)
        expect(toolError(await denied.callTool({ name: 'run_start',
          arguments: { ...input, commandId: randomUUID() } })))
          .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        expect((await f.app.inject({ method: 'POST', url: path,
          headers: { authorization: `Bearer ${reader.token}` }, payload: input })).statusCode).toBe(403)
        expect(resolveRootBinding).not.toHaveBeenCalled()
        expect(f.provider.counts.starts).toBe(0)
        expect((await f.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows)
          .toEqual([])
        expect((await f.services.workflows.current.read(f.writer.principal, {
          workspaceId: input.workspaceId, workflowId: input.workflowId,
        })).version).toEqual(saved.value.version)
      } finally { await f.close() }
    }, 120_000,
  )
})
