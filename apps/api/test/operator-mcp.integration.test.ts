import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema, OperatorToolNameSchema, type ManagementGrant } from '@graphql/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { HarnessResolver } from '../src/modules/harnesses/port.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!().catch(() => undefined)
})

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object')
  return result.structuredContent as Record<string, unknown>
}

function deterministicHarnesses(): HarnessResolver {
  return {
    resolve(harness) {
      return {
        harness,
        qualify: async () => ({
          harness, version: 'integration-fixture', authenticated: true, ready: true,
          structuredEvents: true, supportsResume: true, supportsCancellation: true,
          supportsWorkingDirectory: true, supportsStartupPrompt: true,
          supportedNativeTools: [],
          supportedSettings: harness === 'codex'
            ? ['model', 'reasoningEffort', 'sandbox', 'serviceTier']
            : ['model', 'variant', 'nativeAgent', 'thinking'],
          unsupportedCapabilities: [],
        }),
        execute: async () => ({ outcome: 'succeeded', output: {} }),
        resume: async () => ({ outcome: 'succeeded', output: {} }),
        cancel: async () => true,
      }
    },
  }
}

describe('Operator MCP with PostgreSQL', () => {
  it('uses the real authenticated Streamable HTTP endpoint and shared durable services', async () => {
    const database = createDatabase({ connectionString, maxConnections: 6, connectionTimeoutMs: 5000, queryTimeoutMs: 5000 })
    await database.migrate()
    const settingsBefore = await database.pool.query<{ record: unknown; revision: string; updated_at: Date }>(
      "select record, revision, updated_at from application_settings where key = 'harness-defaults'",
    )
    const restoreSettings = async () => {
      if (settingsBefore.rows[0]) {
        await database.pool.query(
          "insert into application_settings (key, record, revision, updated_at) values ('harness-defaults', $1::jsonb, $2, $3) on conflict (key) do update set record = excluded.record, revision = excluded.revision, updated_at = excluded.updated_at",
          [JSON.stringify(settingsBefore.rows[0].record), settingsBefore.rows[0].revision, settingsBefore.rows[0].updated_at],
        )
      } else {
        await database.pool.query("delete from application_settings where key = 'harness-defaults'")
      }
    }
    const access = new PostgresAccessService(database.pool)
    const grant: ManagementGrant = { actions: ManagementActionSchema.options, scope: {} }
    const issued = await access.issue({ name: 'Integration owner', audience: 'operator', grants: [grant], expiresAt: new Date(Date.now() + 60_000) })
    const worker = await access.issue({ name: 'Worker', audience: 'worker', agentId: 'agent-developer', grants: [grant], expiresAt: new Date(Date.now() + 60_000) })
    const restricted = await access.issue({
      name: 'Restricted operator', audience: 'operator',
      grants: [{ actions: ['capabilities:read', 'workspaces:read', 'workspace_locations:validate'], scope: { workspaceIds: ['not-this-workspace'] } }],
      expiresAt: new Date(Date.now() + 60_000),
    })
    const expired = await access.issue({ name: 'Expiring operator', audience: 'operator', grants: [grant], expiresAt: new Date(Date.now() + 60_000) })
    await database.pool.query("update management_principals set expires_at = now() - interval '1 second' where id = $1", [expired.principal.id])
    const commands = new PostgresCommandCoordinator(database.pool)
    const locations = new WorkspaceLocationService(database.pool, commands, process.cwd())
    const workflowsRepository = new PostgresWorkflowRepository(database.pool)
    const runsRepository = new PostgresRunRepository(database.pool, workflowsRepository, locations)
    const engine = {
      start: vi.fn(async () => undefined),
      cancel: vi.fn(async (runId: string) => {
        const finishedAt = new Date().toISOString()
        await runsRepository.updateState(runId, {
          executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt,
        })
        return true
      }),
    } as unknown as LangGraphWorkflowEngine
    const settings = new PostgresSettingsRepository(database.pool)
    const services = {
      workspaces: new WorkspaceManagementService(database.pool, commands, locations),
      locations,
      workflows: new WorkflowManagementService(database.pool, commands),
      agents: new AgentManagementService(database.pool),
      drafts: new GraphDraftService(database.pool, commands),
      harnesses: new HarnessCatalogService(deterministicHarnesses(), settings, commands, process.cwd()),
      runs: new RunManagementService(database.pool, commands, runsRepository, engine, locations),
      commands,
    }
    const app = buildApp({
      readiness: { database, checkpoints: { ping: async () => undefined } },
      operator: { access, services },
      product: {
        workspaces: new PostgresWorkspaceRepository(database.pool, workflowsRepository, runsRepository),
        workflows: workflowsRepository, runs: runsRepository, settings, engine,
      },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'operator-integration', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('/mcp/operator', address), {
      authProvider: { token: async () => issued.token },
    })
    await client.connect(transport)
    cleanup.push(async () => { await client.close(); await app.close(); await database.close() })
    cleanup.push(restoreSettings)
    cleanup.push(async () => {
      const ids = [issued.principal.id, worker.principal.id, restricted.principal.id, expired.principal.id]
      await database.pool.query('delete from management_command_receipts where principal_id = any($1::text[])', [ids])
      await database.pool.query('delete from management_audit where principal_id = any($1::text[])', [ids])
      await database.pool.query('delete from management_principals where id = any($1::text[])', [ids])
    })

    const tools = await client.listTools()
    const implementedOperatorTools = OperatorToolNameSchema.options.filter((name) => !name.startsWith('interaction_'))
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(implementedOperatorTools.sort())
    expect(tools.tools.every((tool) => tool.inputSchema.additionalProperties === false && tool.outputSchema?.additionalProperties === false)).toBe(true)

    const harnesses = structured(await client.callTool({ name: 'harness_list', arguments: {} })) as unknown as {
      items: Array<{ harness: 'codex' | 'opencode'; defaults: Record<string, unknown>; defaultsRevision: number; capability: unknown }>
    }
    expect(harnesses.items.map((item) => item.harness).sort()).toEqual(['codex', 'opencode'])
    expect(harnesses.items.every((item) => item.capability !== null)).toBe(true)
    const codexHarness = structured(await client.callTool({ name: 'harness_get', arguments: { harness: 'codex' } }))
    expect(codexHarness.harness).toBe('codex')
    const defaults = Object.fromEntries(harnesses.items.map((item) => [item.harness, item.defaults]))
    const defaultsUpdate = structured(await client.callTool({
      name: 'harness_defaults_update', arguments: {
        commandId: `defaults-${randomUUID()}`, expectedRevision: harnesses.items[0]!.defaultsRevision, defaults,
      },
    }))
    expect((defaultsUpdate.value as { revision: number }).revision).toBe(harnesses.items[0]!.defaultsRevision + 1)

    const restrictedClient = new Client({ name: 'restricted-operator', version: '1.0.0' })
    await restrictedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), {
      authProvider: { token: async () => restricted.token },
    }))
    cleanup.push(async () => restrictedClient.close())
    expect((await restrictedClient.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'operator_get_capabilities', 'workspace_get', 'workspace_list', 'workspace_location_validate',
    ])

    const workspaceCommand = `workspace-${randomUUID()}`
    const createdWorkspace = structured(await client.callTool({
      name: 'workspace_create', arguments: { commandId: workspaceCommand, name: 'MCP Integration' },
    }))
    const workspace = (createdWorkspace.value as { workspace: { id: string }; revision: number }).workspace
    const projectDirectory = await mkdtemp(join(tmpdir(), 'graphql-mcp-location-'))
    cleanup.push(() => rm(projectDirectory, { recursive: true, force: true }))
    const replay = structured(await client.callTool({
      name: 'workspace_create', arguments: { commandId: workspaceCommand, name: 'MCP Integration' },
    }))
    expect((replay.value as { workspace: { id: string } }).workspace.id).toBe(workspace.id)
    const workspaceUpdated = structured(await client.callTool({
      name: 'workspace_update', arguments: {
        workspaceId: workspace.id, commandId: `workspace-update-${randomUUID()}`,
        expectedRevision: (createdWorkspace.value as { revision: number }).revision, name: 'MCP Integration Renamed',
      },
    }))
    expect((workspaceUpdated.value as { workspace: { name: string } }).workspace.name).toBe('MCP Integration Renamed')
    const unconfiguredWorkspace = structured(await client.callTool({
      name: 'workspace_get', arguments: { workspaceId: workspace.id },
    })) as unknown as { locationRevision: number; locationValidation: { status: string } }
    expect(unconfiguredWorkspace).toMatchObject({ locationRevision: 0, locationValidation: { status: 'unconfigured' } })
    const locationValidation = structured(await client.callTool({
      name: 'workspace_location_validate', arguments: {
        workspaceId: workspace.id, runnerId: 'runner-local', rootPath: projectDirectory, accessMode: 'read-write',
      },
    })) as unknown as { location: { rootPath: string } }
    expect(locationValidation.location.rootPath).toBe(projectDirectory)
    const locationCommand = `location-${randomUUID()}`
    const locationSet = structured(await client.callTool({
      name: 'workspace_location_set', arguments: {
        workspaceId: workspace.id, runnerId: 'runner-local', rootPath: projectDirectory,
        expectedLocationRevision: 0, commandId: locationCommand,
      },
    })) as unknown as { value: { locationRevision: number; executionLocation: { rootPath: string } } }
    expect(locationSet.value).toMatchObject({ locationRevision: 1, executionLocation: { rootPath: projectDirectory } })
    const httpWorkspace = await fetch(new URL(`/api/management/workspaces/${workspace.id}`, address), {
      headers: { authorization: `Bearer ${issued.token}` },
    })
    expect(httpWorkspace.status).toBe(200)
    await expect(httpWorkspace.json()).resolves.toMatchObject({
      executionLocation: { rootPath: projectDirectory }, locationRevision: 1,
    })
    const locationReplay = structured(await client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId: workspace.id, runnerId: 'runner-local', rootPath: projectDirectory,
      expectedLocationRevision: 0, commandId: locationCommand,
    } })) as unknown as { replayed: boolean; value: { locationRevision: number } }
    expect(locationReplay).toMatchObject({ replayed: true, value: { locationRevision: 1 } })
    const staleLocation = await client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId: workspace.id, runnerId: 'runner-local', rootPath: projectDirectory,
      expectedLocationRevision: 0, commandId: `stale-location-${randomUUID()}`,
    } })
    expect(staleLocation.isError).toBe(true)
    expect(JSON.stringify(staleLocation.structuredContent)).toContain('LOCATION_REVISION_CONFLICT')
    const missingLocation = await client.callTool({ name: 'workspace_location_validate', arguments: {
      workspaceId: workspace.id, runnerId: 'runner-local', rootPath: join(projectDirectory, 'missing'), accessMode: 'read-only',
    } })
    expect(missingLocation.isError).toBe(true)
    expect(JSON.stringify(missingLocation.structuredContent)).toContain('WORKSPACE_LOCATION_NOT_FOUND')
    const secondProjectDirectory = await mkdtemp(join(tmpdir(), 'graphql-mcp-location-second-'))
    cleanup.push(() => rm(secondProjectDirectory, { recursive: true, force: true }))
    const secondWorkspaceResult = structured(await client.callTool({ name: 'workspace_create', arguments: {
      commandId: `workspace-second-${randomUUID()}`, name: 'Second MCP workspace',
    } }))
    const secondWorkspaceId = (secondWorkspaceResult.value as { workspace: { id: string } }).workspace.id
    cleanup.push(async () => { await database.pool.query('delete from workspaces where id = $1', [secondWorkspaceId]) })
    await client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId: secondWorkspaceId, runnerId: 'runner-local', rootPath: secondProjectDirectory,
      expectedLocationRevision: 0, commandId: `location-second-${randomUUID()}`,
    } })
    const secondWorkspace = structured(await client.callTool({ name: 'workspace_get', arguments: { workspaceId: secondWorkspaceId } }))
    expect((secondWorkspace.executionLocation as { rootPath: string }).rootPath).toBe(secondProjectDirectory)
    expect((structured(await client.callTool({ name: 'workspace_get', arguments: { workspaceId: workspace.id } })).executionLocation as { rootPath: string }).rootPath)
      .toBe(projectDirectory)
    const workspaceList = structured(await client.callTool({ name: 'workspace_list', arguments: { limit: 100 } }))
    expect((workspaceList.items as Array<{ workspace: { id: string } }>).some((item) => item.workspace.id === workspace.id)).toBe(true)
    cleanup.push(async () => {
      await database.pool.query('delete from run_activity where run_id in (select id from runs where workspace_id = $1)', [workspace.id])
      await database.pool.query('delete from harness_executions where run_id in (select id from runs where workspace_id = $1)', [workspace.id])
      await database.pool.query('delete from runs where workspace_id = $1', [workspace.id])
      await database.pool.query('delete from graph_drafts where workspace_id = $1', [workspace.id])
      await database.pool.query('delete from workflow_versions where workspace_id = $1', [workspace.id])
      await database.pool.query('delete from agent_configuration_versions where workspace_id = $1', [workspace.id])
      await database.pool.query('delete from agents where workspace_id = $1', [workspace.id])
      await database.pool.query('delete from workflows where workspace_id = $1', [workspace.id])
      await database.pool.query('delete from workspaces where id = $1', [workspace.id])
    })

    const workflowResult = structured(await client.callTool({
      name: 'workflow_create', arguments: { workspaceId: workspace.id, commandId: `workflow-${randomUUID()}`, name: 'Saved workflow' },
    }))
    const workflow = (workflowResult.value as { workflow: { id: string } }).workflow
    const workflowUpdated = structured(await client.callTool({
      name: 'workflow_update', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, commandId: `workflow-update-${randomUUID()}`,
        expectedRevision: (workflowResult.value as { revision: number }).revision, name: 'Saved workflow renamed',
      },
    }))
    expect((workflowUpdated.value as { workflow: { name: string } }).workflow.name).toBe('Saved workflow renamed')
    const workflowList = structured(await client.callTool({
      name: 'workflow_list', arguments: { workspaceId: workspace.id, limit: 100 },
    }))
    expect((workflowList.items as Array<{ workflow: { id: string } }>).some((item) => item.workflow.id === workflow.id)).toBe(true)

    const discardedWorkflow = structured(await client.callTool({
      name: 'workflow_create', arguments: { workspaceId: workspace.id, commandId: `discard-workflow-${randomUUID()}`, name: 'Discard probe' },
    }))
    const discardedWorkflowId = (discardedWorkflow.value as { workflow: { id: string } }).workflow.id
    const discardDraft = structured(await client.callTool({
      name: 'graph_draft_open', arguments: { workspaceId: workspace.id, workflowId: discardedWorkflowId },
    })) as unknown as { id: string; revision: number }
    const discardResult = structured(await client.callTool({
      name: 'graph_draft_discard', arguments: {
        workspaceId: workspace.id, workflowId: discardedWorkflowId, draftId: discardDraft.id,
        commandId: `discard-${randomUUID()}`, expectedRevision: discardDraft.revision,
      },
    }))
    expect((discardResult.value as { discarded: boolean }).discarded).toBe(true)
    const opened = structured(await client.callTool({
      name: 'graph_draft_open', arguments: { workspaceId: workspace.id, workflowId: workflow.id },
    }))
    const draft = opened as unknown as { id: string; revision: number }
    const rolledBack = await client.callTool({
      name: 'graph_draft_apply', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id,
        commandId: `rollback-${randomUUID()}`, expectedRevision: draft.revision,
        operations: [
          { type: 'agent.add', agentId: `rolled-back-agent-${randomUUID()}`, nodeId: `rolled-back-node-${randomUUID()}`, name: 'Rollback', harness: 'codex' },
          { type: 'edge.disconnect', edgeId: 'missing-edge' },
        ],
      },
    })
    expect(rolledBack.isError).toBe(true)
    const afterRollback = structured(await client.callTool({
      name: 'graph_draft_get', arguments: { workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id },
    })) as unknown as { revision: number; graph: { nodes: unknown[] } }
    expect(afterRollback).toMatchObject({ revision: draft.revision, graph: { nodes: [] } })
    const codexAgentId = `agent-codex-${randomUUID()}`
    const openCodeAgentId = `agent-opencode-${randomUUID()}`
    const cloneAgentId = `agent-clone-${randomUUID()}`
    const codexNodeId = `node-codex-${randomUUID()}`
    const openCodeNodeId = `node-opencode-${randomUUID()}`
    const cloneNodeId = `node-clone-${randomUUID()}`
    const edgeId = `edge-${randomUUID()}`
    const applied = structured(await client.callTool({
      name: 'graph_draft_apply', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id,
        commandId: `apply-${randomUUID()}`, expectedRevision: draft.revision,
        operations: [
          { type: 'agent.add', agentId: codexAgentId, nodeId: codexNodeId, name: 'Codex', harness: 'codex' },
          { type: 'agent.configure', agentId: codexAgentId, expectedAgentRevision: 0, configuration: {
            harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
          } },
          { type: 'agent.add', agentId: openCodeAgentId, nodeId: openCodeNodeId, name: 'OpenCode', harness: 'opencode' },
          { type: 'agent.rename', agentId: openCodeAgentId, expectedAgentRevision: 0, name: 'OpenCode renamed' },
          { type: 'agent.configure', agentId: openCodeAgentId, expectedAgentRevision: 0, configuration: {
            harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max', nativeAgent: 'build', thinking: false, autoApprove: false,
          } },
          { type: 'node.rename', nodeId: codexNodeId, name: 'Codex step' },
          { type: 'node.set_initial_prompt', nodeId: openCodeNodeId, initialPrompt: 'Summarize only the accepted input.' },
          { type: 'node.move', nodeId: codexNodeId, position: { x: 10, y: 20 } },
          { type: 'edge.connect', edgeId, sourceNodeId: codexNodeId, targetNodeId: openCodeNodeId },
          { type: 'agent.clone', sourceAgentId: codexAgentId, agentId: cloneAgentId, nodeId: cloneNodeId, name: 'Codex clone' },
          { type: 'node.remove', nodeId: cloneNodeId },
          { type: 'workflow.set_execution_limits', maxParallelism: 2, maxNodeExecutions: 2 },
        ],
      },
    }))
    let changedDraft = (applied.value as { draft: { id: string; revision: number } }).draft
    const reconnected = structured(await client.callTool({
      name: 'graph_draft_apply', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id,
        commandId: `reconnect-${randomUUID()}`, expectedRevision: changedDraft.revision,
        operations: [
          { type: 'edge.disconnect', edgeId },
          { type: 'edge.connect', edgeId, sourceNodeId: codexNodeId, targetNodeId: openCodeNodeId },
        ],
      },
    }))
    changedDraft = (reconnected.value as { draft: { id: string; revision: number } }).draft
    const mismatchedCount = structured(await client.callTool({
      name: 'graph_draft_apply', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id,
        commandId: `required-count-mismatch-${randomUUID()}`, expectedRevision: changedDraft.revision,
        operations: [{ type: 'workflow.set_required_agent_count', requiredAgentCount: 3 }],
      },
    }))
    changedDraft = (mismatchedCount.value as { draft: { id: string; revision: number } }).draft
    const rejectedCount = structured(await client.callTool({
      name: 'graph_validate', arguments: { workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id },
    })) as unknown as { valid: boolean; issues: Array<{ code: string }> }
    expect(rejectedCount).toMatchObject({ valid: false, issues: [{ code: 'WORKFLOW_AGENT_COUNT_MISMATCH' }] })
    const rejectedSave = await client.callTool({
      name: 'graph_save', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id,
        commandId: `required-count-save-rejected-${randomUUID()}`, expectedRevision: changedDraft.revision,
      },
    })
    expect(rejectedSave.isError).toBe(true)
    expect(rejectedSave.structuredContent).toMatchObject({
      error: { code: 'GRAPH_INVALID', details: { issues: [{ code: 'WORKFLOW_AGENT_COUNT_MISMATCH' }] } },
    })
    const correctedCount = structured(await client.callTool({
      name: 'graph_draft_apply', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id,
        commandId: `required-count-corrected-${randomUUID()}`, expectedRevision: changedDraft.revision,
        operations: [{ type: 'workflow.set_required_agent_count', requiredAgentCount: 2 }],
      },
    }))
    changedDraft = (correctedCount.value as { draft: { id: string; revision: number } }).draft
    const validation = structured(await client.callTool({
      name: 'graph_validate', arguments: { workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id },
    }))
    expect(validation.valid).toBe(true)
    const saved = structured(await client.callTool({
      name: 'graph_save', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, draftId: draft.id,
        commandId: `save-${randomUUID()}`, expectedRevision: changedDraft.revision,
      },
    }))
    const savedValue = saved.value as { version: { id: string } }
    const agentsPage = structured(await client.callTool({
      name: 'agent_list', arguments: { workspaceId: workspace.id, workflowId: workflow.id, limit: 100 },
    }))
    expect((agentsPage.items as Array<{ agent: { id: string } }>).map((item) => item.agent.id)).toEqual(expect.arrayContaining([codexAgentId, openCodeAgentId]))
    const agentDetail = structured(await client.callTool({
      name: 'agent_get', arguments: { workspaceId: workspace.id, agentId: openCodeAgentId },
    }))
    expect(agentDetail.workflowIds).toEqual([workflow.id])
    const runCommand = `run-${randomUUID()}`
    const startArguments = {
      workspaceId: workspace.id, workflowId: workflow.id, workflowVersionId: savedValue.version.id,
      expectedLocationRevision: 1, commandId: runCommand, input: { message: 'bounded integration' },
    }
    const [startedResult, duplicateResult] = await Promise.all([
      client.callTool({ name: 'run_start', arguments: startArguments }),
      client.callTool({ name: 'run_start', arguments: startArguments }),
    ])
    const started = structured(startedResult)
    const run = (started as unknown as { run: { id: string } }).run
    const duplicate = structured(duplicateResult)
    expect((duplicate as unknown as { run: { id: string } }).run.id).toBe(run.id)
    await vi.waitFor(() => expect(engine.start).toHaveBeenCalledOnce())
    const replacementDirectory = await mkdtemp(join(tmpdir(), 'graphql-mcp-location-next-'))
    cleanup.push(() => rm(replacementDirectory, { recursive: true, force: true }))
    const changedLocation = await fetch(new URL(`/api/management/workspaces/${workspace.id}/location`, address), {
      method: 'PUT', headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runnerId: 'runner-local', rootPath: replacementDirectory,
        expectedLocationRevision: 1, commandId: `location-next-${randomUUID()}` }),
    })
    expect(changedLocation.status).toBe(200)
    await expect(changedLocation.json()).resolves.toMatchObject({ value: { locationRevision: 2 } })
    expect(structured(await client.callTool({ name: 'workspace_get', arguments: { workspaceId: workspace.id } })))
      .toMatchObject({ executionLocation: { rootPath: replacementDirectory }, locationRevision: 2 })
    const duplicateAfterLocationChange = structured(await client.callTool({ name: 'run_start', arguments: startArguments }))
    expect((duplicateAfterLocationChange as unknown as { run: { id: string; executionLocation: { rootPath: string; locationRevision: number } } }).run)
      .toMatchObject({ id: run.id, executionLocation: { rootPath: projectDirectory, locationRevision: 1 } })

    const conflict = await client.callTool({
      name: 'run_start', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, workflowVersionId: savedValue.version.id,
        expectedLocationRevision: 1, commandId: runCommand, input: { message: 'different' },
      },
    })
    expect(conflict.isError).toBe(true)

    const workflowRead = structured(await client.callTool({
      name: 'workflow_get', arguments: { workspaceId: workspace.id, workflowId: workflow.id },
    })) as unknown as { revision: number }
    const blockedArchive = await client.callTool({
      name: 'workflow_archive', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, expectedRevision: workflowRead.revision,
        commandId: `archive-${randomUUID()}`,
      },
    })
    expect(blockedArchive.isError).toBe(true)

    const runsPage = structured(await client.callTool({
      name: 'run_list', arguments: { workspaceId: workspace.id, workflowId: workflow.id, limit: 100 },
    }))
    expect((runsPage.items as Array<{ id: string }>).map((item) => item.id)).toContain(run.id)
    const runDetail = structured(await client.callTool({
      name: 'run_get', arguments: { workspaceId: workspace.id, runId: run.id },
    }))
    expect((runDetail.run as { workflowVersionId: string }).workflowVersionId).toBe(savedValue.version.id)
    const events = structured(await client.callTool({
      name: 'run_events_list', arguments: { workspaceId: workspace.id, runId: run.id, limit: 100 },
    }))
    expect((events.items as unknown[]).length).toBeGreaterThan(0)
    const stopCommand = `stop-${randomUUID()}`
    const stopped = structured(await client.callTool({
      name: 'run_stop', arguments: { workspaceId: workspace.id, runId: run.id, commandId: stopCommand },
    }))
    expect(stopped).toMatchObject({ runId: run.id, status: 'accepted', processStopped: false, replayed: false })
    const stoppedReplay = structured(await client.callTool({
      name: 'run_stop', arguments: { workspaceId: workspace.id, runId: run.id, commandId: stopCommand },
    }))
    expect(stoppedReplay).toMatchObject({ runId: run.id, status: 'accepted', replayed: true })

    const archivedWorkflow = structured(await client.callTool({
      name: 'workflow_archive', arguments: {
        workspaceId: workspace.id, workflowId: workflow.id, expectedRevision: workflowRead.revision,
        commandId: `archive-settled-${randomUUID()}`,
      },
    }))
    expect((archivedWorkflow.value as { archivedAt: string | null }).archivedAt).not.toBeNull()
    const retainedRun = structured(await client.callTool({
      name: 'run_get', arguments: { workspaceId: workspace.id, runId: run.id },
    }))
    expect((retainedRun.run as { id: string }).id).toBe(run.id)
    await rm(replacementDirectory, { recursive: true, force: true })
    const unavailableWorkspace = structured(await client.callTool({
      name: 'workspace_get', arguments: { workspaceId: workspace.id },
    }))
    expect(unavailableWorkspace).toMatchObject({
      executionLocation: { rootPath: replacementDirectory },
      locationValidation: { status: 'unavailable', error: { code: 'WORKSPACE_LOCATION_NOT_FOUND' } },
    })
    const currentWorkspace = structured(await client.callTool({
      name: 'workspace_get', arguments: { workspaceId: workspace.id },
    })) as unknown as { revision: number }
    const archivedWorkspace = structured(await client.callTool({
      name: 'workspace_archive', arguments: {
        workspaceId: workspace.id, expectedRevision: currentWorkspace.revision,
        commandId: `archive-workspace-${randomUUID()}`,
      },
    }))
    expect((archivedWorkspace.value as { archivedAt: string | null }).archivedAt).not.toBeNull()

    const crossWorkspace = await restrictedClient.callTool({
      name: 'workspace_get', arguments: { workspaceId: workspace.id },
    })
    expect(crossWorkspace.isError).toBe(true)
    const deniedLocationProbe = await restrictedClient.callTool({ name: 'workspace_location_validate', arguments: {
      workspaceId: workspace.id, runnerId: 'runner-local', rootPath: projectDirectory, accessMode: 'read-only',
    } })
    expect(deniedLocationProbe.isError).toBe(true)
    expect(JSON.stringify(deniedLocationProbe.structuredContent)).toContain('ACCESS_DENIED')

    const unauthenticated = await fetch(new URL('/mcp/operator', address), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauthenticated.status).toBe(401)
    const unauthenticatedLocation = await fetch(new URL(`/api/management/workspaces/${workspace.id}/location/validate`, address), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runnerId: 'runner-local', rootPath: projectDirectory, accessMode: 'read-only' }),
    })
    expect(unauthenticatedLocation.status).toBe(401)
    const workerResponse = await fetch(new URL('/mcp/operator', address), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${worker.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(workerResponse.status).toBe(403)
    const expiredResponse = await fetch(new URL('/mcp/operator', address), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${expired.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(expiredResponse.status).toBe(401)
    const badOrigin = await fetch(new URL('/mcp/operator', address), {
      method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${issued.token}`, origin: 'https://example.com',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(badOrigin.status).toBe(403)

    const legacyBypass = await fetch(new URL(`/api/workspaces/${workspace.id}/graph`, address), {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ workspaceId: workspace.id, workflow: { id: workflow.id, workspaceId: workspace.id, name: 'Bypass', executionCondition: { kind: 'manual' }, nodes: [], edges: [] } }),
    })
    expect(legacyBypass.status).toBe(409)

    const enrollment = await fetch(new URL('/api/auth/enroll', address), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: issued.token }),
    })
    const cookie = enrollment.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    const csrf = await fetch(new URL('/api/management/workspaces', address), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ commandId: `csrf-${randomUUID()}`, name: 'Must not be created' }),
    })
    expect(csrf.status).toBe(403)

    await access.revoke(restricted.principal.id)
    const revoked = await fetch(new URL('/mcp/operator', address), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${restricted.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(revoked.status).toBe(401)
  }, 30_000)
})
