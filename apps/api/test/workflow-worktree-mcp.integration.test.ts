import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { Client } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { WorkspaceRepositoryAddResultSchema, WorkspaceRepositoryReadResultSchema } from '@foreman-code/contracts/workspace-git'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentMutationResultSchema, ManagedWorkspaceCommandResultSchema, ManagementActionSchema } from '@foreman-code/contracts/management'
import {
  CurrentEditReadResultSchema, CurrentWorkflowCapabilitiesSchema, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema, SavedManagedWorkflowSchema,
  makeCurrentWorkflowFixture, type CurrentWorkflowSaveInput,
} from '@foreman-code/contracts/wave25'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { mixedComputerPlacement } from './helpers/mixedComputerPlacement.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { workspaceRepositoryFixture, fixtureRepository } from './helpers/workspaceRepository.js'

const repository = { provider: 'github' as const, owner: 'octo-owner', name: 'website', defaultBranch: 'main' }

async function setup(options: { sourceAccessMode?: 'read-only' | 'exclusive-write' } = {}) {
  const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'),
    agentManagement: true })
  const directory = await privateFixtureDirectory('workflow-worktree-')
  try {
    const placement = await mixedComputerPlacement(base, directory, {
      git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1', repository: 'octo-owner/website' },
      sourceAccessMode: options.sourceAccessMode ?? 'exclusive-write',
    })
    const workspaceId = base.f.scope.workspaceId
    const workspace = await base.services.workspaces.get(base.writer.principal, workspaceId)
    await base.services.workspaces.update(base.writer.principal, 'mcp', {
      workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision, repository,
    })
    const services = { readyRoot: async () => placement.local.rootBinding,
      sources: placement.sources, roots: placement.policies }
    base.services.workflows = new WorkflowManagementService(base.db.pool, base.commands, undefined, services)
    async function create(defaultWorktree?: Parameters<typeof base.services.workflows.create>[2]['defaultWorktree']) {
      const input = { workspaceId, commandId: randomUUID(), name: 'Worktree workflow',
        ...(defaultWorktree === undefined ? {} : { defaultWorktree }) }
      const result = await base.client.callTool({ name: 'workflow_create', arguments: input })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(result))
      const graph = { ...base.f.version.definition, ...created.value.workflow,
        version: created.value.workflow.version,
        nodes: base.f.version.definition.nodes, edges: base.f.version.definition.edges,
        entryNodeId: base.f.version.definition.entryNodeId,
        executionPolicy: base.f.version.definition.executionPolicy }
      const saveInput: CurrentWorkflowSaveInput = {
        workspaceId, workflowId: created.value.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: created.value.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: base.f.version.agentConfigurationVersionIds,
        expectedLocationRevision: placement.locationRevision, graph,
      }
      return { input, created, saveInput }
    }
    async function save(input: CurrentWorkflowSaveInput, client: Client = base.client) {
      const result = await client.callTool({ name: 'workflow_save_v3', arguments: input })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(result))
    }
    async function read(workflowId: string) {
      const result = await base.client.callTool({ name: 'workflow_saved_get_v3', arguments: { workspaceId, workflowId } })
      expect(result.isError).not.toBe(true)
      return CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(result))
    }
    return { base, placement, workspaceId, create, save, read, services,
      async close() { await base.close(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) {
    await base.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

describe.runIf(postgresEnabled)('workflow worktrees through authenticated MCP', () => {
  it('copies a prepared repository through the domain services and keeps grants conditional', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      f.services.workflows = new WorkflowManagementService(f.pool, f.commands, undefined, {
        readyRoot: (principal, workspaceId, sql) => f.repositories.readyRoot(principal, workspaceId, sql),
        sources: f.sources, roots: f.policies,
      })
      const workspaceResponse = await f.owner.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Imported workflow project',
      } })
      expect(workspaceResponse.isError).not.toBe(true)
      const workspace = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(workspaceResponse)).value
      const creator = await f.issue([{ actions: ['workflows:create'], scope: { workspaceIds: [workspace.workspace.id] } }])
      const empty = await creator.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'No prepared project',
      } })
      expect(empty.isError, JSON.stringify(empty)).not.toBe(true)
      expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(empty)).value.workflow)
        .not.toHaveProperty('defaultWorktree')
      const preparedResponse = await f.owner.client.callTool({ name: 'workspace_repository_add', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), expectedRevision: workspace.revision,
        expectedLocationRevision: workspace.locationRevision, expectedRootPolicyRevision: 0, expectedBindingRevision: 0,
        repository: fixtureRepository, allowedBaseId: f.allowlist.bases[0]!.baseId,
        configurationRevision: f.allowlist.configurationRevision,
      } })
      expect(preparedResponse.isError, JSON.stringify(preparedResponse)).not.toBe(true)
      const prepared = WorkspaceRepositoryAddResultSchema.parse(decodeMcpToolResult(preparedResponse)).value
      expect(prepared.state).toBe('ready')
      const projectRead = await f.owner.client.callTool({ name: 'workspace_repository_get', arguments: {
        workspaceId: workspace.workspace.id,
      } })
      expect(WorkspaceRepositoryReadResultSchema.parse(decodeMcpToolResult(projectRead)).rootBinding)
        .toEqual(prepared.rootBinding)
      const createdResponse = await f.owner.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'Prepared source',
      } })
      expect(createdResponse.isError, JSON.stringify(createdResponse)).not.toBe(true)
      const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(createdResponse)).value
      expect(created.workflow.defaultWorktree).toEqual({ rootBinding: prepared.rootBinding })
      const read = await f.owner.client.callTool({ name: 'workflow_get', arguments: {
        workspaceId: workspace.workspace.id, workflowId: created.workflow.id,
      } })
      expect(SavedManagedWorkflowSchema.parse(decodeMcpToolResult(read)).workflow.defaultWorktree)
        .toEqual(created.workflow.defaultWorktree)
      await expectMcpAccessDenied(creator.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'Missing project grants',
      } }))
      const optedOut = await creator.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'Explicit opt-out', defaultWorktree: null,
      } })
      expect(optedOut.isError).not.toBe(true)
      expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(optedOut)).value.workflow)
        .not.toHaveProperty('defaultWorktree')
    } finally { await f.close() }
  }, 30_000)

  it('reads capabilities, seeds creation, saves an override and clears it through the same writer', async () => {
    const f = await setup()
    try {
      const capabilities = await f.base.client.callTool({ name: 'workflow_authoring_capabilities_v3', arguments: {} })
      expect(CurrentWorkflowCapabilitiesSchema.parse(decodeMcpToolResult(capabilities)).worktrees)
        .toMatchObject({ workflowDefault: true, agentBranchOverride: true, creationOptOut: true })
      const created = await f.create()
      expect(created.created.value.workflow.defaultWorktree).toEqual({ rootBinding: f.placement.local.rootBinding })
      expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(await f.base.client.callTool({
        name: 'workflow_create', arguments: created.input,
      })))).toEqual({ ...created.created, replayed: true })
      const input = created.saveInput
      input.graph.defaultWorktree = { rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/site' }
      const overridden = agentWorkflowNode(input.graph.nodes[0])
      overridden.placement = f.placement.remote
      overridden.worktree = { branchPrefix: 'foreman/site/review' }
      agentWorkflowNode(input.graph.nodes[1]).worktree = { branchPrefix: 'foreman/site/build' }
      const saved = await f.save(input)
      expect(await f.save(input)).toEqual({ ...saved, replayed: true })
      expect((await f.read(input.workflowId)).version.definition).toEqual(saved.value.version.definition)

      f.base.services.workflows = new WorkflowManagementService(f.base.db.pool, f.base.commands, undefined, f.services)
      const reloaded = await f.base.client.callTool({ name: 'workflow_get', arguments: {
        workspaceId: f.workspaceId, workflowId: input.workflowId,
      } })
      const definition = SavedManagedWorkflowSchema.parse(decodeMcpToolResult(reloaded)).workflow
      expect(agentWorkflowNode(definition.nodes[0]).worktree?.branchPrefix).toBe('foreman/site/review')
      const inherited = agentWorkflowNode(definition.nodes[0])
      delete inherited.placement
      delete inherited.worktree
      const cleared = await f.save({ ...input, commandId: randomUUID(), graph: definition,
        expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId })
      const readback = (await f.read(input.workflowId)).version.definition
      expect(agentWorkflowNode(readback.nodes[0])).not.toHaveProperty('placement')
      expect(agentWorkflowNode(readback.nodes[0])).not.toHaveProperty('worktree')
      expect(readback.defaultWorktree).toEqual(input.graph.defaultWorktree)
      expect(cleared.value.currentVersionId).not.toBe(saved.value.currentVersionId)
      const historicalResponse = await f.base.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        workspaceId: f.workspaceId, workflowId: input.workflowId, workflowVersionId: saved.value.currentVersionId,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(historicalResponse)).version)
        .toEqual(saved.value.version)
      const withoutDefault = structuredClone(readback)
      delete withoutDefault.defaultWorktree
      for (const node of withoutDefault.nodes) {
        if (node.kind === 'job') continue
        delete node.placement
        delete node.worktree
      }
      await f.save({ ...input, commandId: randomUUID(), graph: withoutDefault,
        expectedRevision: cleared.value.revision, expectedWorkflowVersionId: cleared.value.currentVersionId })
      expect((await f.read(input.workflowId)).version.definition).not.toHaveProperty('defaultWorktree')
      expect((await f.base.db.pool.query<{ source: string; outcome: string }>(
        "select source,outcome from management_audit where action='workflow.save.v3' and details->>'commandId'=$1",
        [input.commandId])).rows).toEqual([{ source: 'mcp', outcome: 'succeeded' }])
    } finally { await f.close() }
  }, 30_000)

  it('supports explicit creation opt-out and denies missing selection grants and read-only writers', async () => {
    const f = await setup()
    try {
      expect((await f.create(null)).created.value.workflow).not.toHaveProperty('defaultWorktree')
      const created = await f.create({ rootBinding: f.placement.remote.rootBinding!, branchPrefix: 'foreman/remote' })
      expect(created.created.value.workflow.defaultWorktree?.rootBinding).toEqual(f.placement.remote.rootBinding)
      const deniedActions = ['sources:read', 'source_roots:read', 'workspace_locations:read'] as const
      for (const missing of deniedActions) {
        const issued = await f.base.access.issue({ name: `Missing ${missing}`, audience: 'operator',
          expiresAt: new Date(Date.now() + 600000), grants: [{
            actions: ManagementActionSchema.options.filter(action => action !== missing), scope: { workspaceIds: [f.workspaceId] },
          }] })
        const client = await f.base.connect(issued.token)
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_create', arguments: {
          workspaceId: f.workspaceId, commandId: randomUUID(), name: 'Denied configured workflow',
          defaultWorktree: { rootBinding: f.placement.local.rootBinding },
        } }))
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_save_v3', arguments: created.saveInput }))
      }
      const reader = await f.base.access.issue({ name: 'Read-only workflow caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [f.workspaceId] } }] })
      const readerClient = await f.base.connect(reader.token)
      await expectMcpAccessDenied(readerClient.callTool({ name: 'workflow_save_v3', arguments: created.saveInput }))
      expect((await f.base.db.pool.query<{ outcome: string }>(
        "select outcome from management_audit where principal_id=$1 and action='workflow_save_v3'",
        [reader.principal.id])).rows).toEqual([{ outcome: 'denied' }])
    } finally { await f.close() }
  }, 30_000)

  it('rejects stale saves, foreign roots, repository substitutions and unavailable source bytes', async () => {
    const f = await setup()
    try {
      const { saveInput } = await f.create()
      const saved = await f.save(saveInput)
      let next = { ...saveInput, commandId: randomUUID(), graph: saved.value.version.definition,
        expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId }
      const failures = [
        { ...next, expectedRevision: next.expectedRevision - 1 },
        { ...next, graph: { ...next.graph, defaultWorktree: { rootBinding: { rootId: randomUUID(), bindingRevision: 1 } } } },
      ]
      for (const input of failures) {
        expect((await f.base.client.callTool({ name: 'workflow_save_v3', arguments: input })).isError).toBe(true)
      }
      const otherWorkspace = await f.base.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Other workspace',
      } })
      expect(otherWorkspace.isError).not.toBe(true)
      const otherWorkspaceId = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(otherWorkspace)).value.workspace.id
      expect(await f.base.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: otherWorkspaceId, commandId: randomUUID(), name: 'Foreign root',
        defaultWorktree: { rootBinding: f.placement.local.rootBinding },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_ROOT_NOT_FOUND') }] })
      const workspace = await f.base.services.workspaces.get(f.base.writer.principal, f.workspaceId)
      const metadataChange = await f.base.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId: f.workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision,
        repository: { ...repository, name: 'another-project' },
      } })
      expect(metadataChange.isError).not.toBe(true)
      expect(await f.base.client.callTool({ name: 'workflow_save_v3', arguments: {
        ...next, graph: { ...next.graph, defaultWorktree: { rootBinding: f.placement.remote.rootBinding } },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKTREE_REPOSITORY_CONFLICT') }] })
      const retained = await f.save({ ...next, commandId: randomUUID(), graph: {
        ...next.graph, defaultWorktree: { rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/retained' },
      } })
      next = { ...next, commandId: randomUUID(), expectedRevision: retained.value.revision,
        expectedWorkflowVersionId: retained.value.currentVersionId, graph: retained.value.version.definition }
      await f.base.db.pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
        [f.placement.source.snapshotId])
      expect(await f.base.client.callTool({ name: 'workflow_validate_v3', arguments: {
        workspaceId: next.workspaceId, workflowId: next.workflowId, executionSemanticsVersion: 3,
        expectedRevision: next.expectedRevision, expectedWorkflowVersionId: next.expectedWorkflowVersionId,
        expectedAgentConfigurationVersionIds: next.expectedAgentConfigurationVersionIds,
        expectedLocationRevision: next.expectedLocationRevision, graph: next.graph,
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_UNAVAILABLE') }] })
      expect((await f.read(next.workflowId)).version).toEqual(retained.value.version)
    } finally { await f.close() }
  }, 30_000)

  it('authorizes and validates root-only Agent overrides without a workflow default or branch prefix', async () => {
    const f = await setup()
    try {
      const { saveInput } = await f.create(null)
      agentWorkflowNode(saveInput.graph.nodes[0]).placement = f.placement.local
      expect(saveInput.graph).not.toHaveProperty('defaultWorktree')
      expect(agentWorkflowNode(saveInput.graph.nodes[0])).not.toHaveProperty('worktree')
      for (const missing of ['sources:read', 'source_roots:read', 'workspace_locations:read'] as const) {
        const issued = await f.base.access.issue({ name: `Root-only missing ${missing}`, audience: 'operator',
          expiresAt: new Date(Date.now() + 600000), grants: [{
            actions: ManagementActionSchema.options.filter(action => action !== missing),
            scope: { workspaceIds: [f.workspaceId] },
          }] })
        const client = await f.base.connect(issued.token)
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_save_v3', arguments: saveInput }))
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_edit_v3', arguments: {
          ...saveInput, action: 'stage_edits', draftId: randomUUID(),
        } }))
      }
      const reader = await f.base.access.issue({ name: 'Root-only reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [f.workspaceId] } }] })
      await expectMcpAccessDenied((await f.base.connect(reader.token)).callTool({
        name: 'workflow_save_v3', arguments: saveInput,
      }))
      const saved = await f.save(saveInput)
      expect(agentWorkflowNode((await f.read(saveInput.workflowId)).version.definition.nodes[0]).placement)
        .toEqual(f.placement.local)
      const next = { ...saveInput, commandId: randomUUID(), graph: structuredClone(saved.value.version.definition),
        expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId }
      const workspace = await f.base.services.workspaces.get(f.base.writer.principal, f.workspaceId)
      const changed = await f.base.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId: f.workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision,
        repository: { ...repository, name: 'other-project' },
      } })
      expect(changed.isError).not.toBe(true)
      agentWorkflowNode(next.graph.nodes[0]).placement = f.placement.remote
      expect(await f.base.client.callTool({ name: 'workflow_save_v3', arguments: next }))
        .toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKTREE_REPOSITORY_CONFLICT') }] })
      agentWorkflowNode(next.graph.nodes[0]).placement = f.placement.local
      await f.base.db.pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
        [f.placement.source.snapshotId])
      expect(await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: {
        ...next, commandId: randomUUID(), action: 'stage_edits', draftId: randomUUID(),
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_UNAVAILABLE') }] })
      expect((await f.read(saveInput.workflowId)).version).toEqual(saved.value.version)
    } finally { await f.close() }
  }, 30_000)

  it('rejects a root-only Agent override bound to another workspace', async () => {
    const f = await setup()
    try {
      const workspaceResponse = await f.base.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Foreign Agent root',
      } })
      expect(workspaceResponse.isError).not.toBe(true)
      const workspace = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(workspaceResponse)).value
      const workspaceId = workspace.workspace.id
      const agentResponse = await f.base.client.callTool({ name: 'agent_create', arguments: {
        workspaceId, agentId: randomUUID(), commandId: randomUUID(), name: 'Worker',
        configuration: f.base.f.configurations[0]!.harness,
      } })
      expect(agentResponse.isError, JSON.stringify(agentResponse)).not.toBe(true)
      const agent = AgentMutationResultSchema.parse(decodeMcpToolResult(agentResponse)).value.agent
      const workflowResponse = await f.base.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId, commandId: randomUUID(), name: 'Foreign source selection', defaultWorktree: null,
      } })
      expect(workflowResponse.isError).not.toBe(true)
      const workflow = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(workflowResponse)).value
      const nodeId = randomUUID()
      expect(await f.base.client.callTool({ name: 'workflow_save_v3', arguments: {
        workspaceId, workflowId: workflow.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: workflow.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId },
        expectedLocationRevision: workspace.locationRevision,
        graph: { ...workflow.workflow, entryNodeId: nodeId, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
          nodes: [{ id: nodeId, kind: 'agent', name: 'Worker', agentId: agent.id, placement: f.placement.remote }] },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_ROOT_NOT_FOUND') }] })
    } finally { await f.close() }
  }, 30_000)

  it.each(['sources:read', 'source_roots:read', 'workspace_locations:read'] as const)
  ('reauthorizes worktree edit receipts after removal of %s', async missing => {
    const f = await setup()
    try {
      const { saveInput } = await f.create()
      const saved = (await f.save(saveInput)).value
      const stage = { ...saveInput, action: 'stage_edits', draftId: randomUUID(), commandId: randomUUID(),
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...saved.version.definition, defaultWorktree: {
          rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/staged',
        } } }
      const callEdit = async (input: Record<string, unknown>) => {
        const result = await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: input })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        return CurrentEditReadResultSchema.parse(decodeMcpToolResult(result))
      }
      const setGrants = (grants: typeof f.base.writer.principal.grants) => f.base.db.pool.query(
        'update management_principals set grants=$2::jsonb where id=$1',
        [f.base.writer.principal.id, JSON.stringify(grants)])
      const fullGrants = f.base.writer.principal.grants
      const narrowedGrants = fullGrants.map(grant => ({ ...grant, actions: grant.actions.filter(action => action !== missing) }))
      const staged = await callEdit(stage)
      expect(await callEdit(stage)).toEqual(staged)
      const intent = staged.intent!
      const advance = { workspaceId: f.workspaceId, workflowId: saveInput.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }
      const readInput = { action: 'read_edits', workspaceId: f.workspaceId, workflowId: saveInput.workflowId,
        draftId: stage.draftId, intentId: intent.id }
      await setGrants(narrowedGrants)
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: stage }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: advance }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edits_get_v3', arguments: readInput }))
      await setGrants(fullGrants)
      const completed = await callEdit(advance)
      expect(completed.intent?.state).toBe('saved')
      expect(await callEdit(advance)).toEqual(completed)
      const published = completed.intent!.result!
      const discardedStage = { ...stage, commandId: randomUUID(), draftId: randomUUID(),
        expectedRevision: published.revision, expectedWorkflowVersionId: published.currentVersionId,
        graph: { ...published.version.definition, defaultWorktree: {
          rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/discarded',
        } } }
      const discardIntent = (await callEdit(discardedStage)).intent!
      const discard = { workspaceId: f.workspaceId, workflowId: saveInput.workflowId, draftId: discardedStage.draftId,
        intentId: discardIntent.id, action: 'discard_edits', commandId: discardIntent.discardCommandId }
      expect((await callEdit(discard)).intent?.state).toBe('discarded')
      await setGrants(narrowedGrants)
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: stage }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: advance }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: discard }))
      expect((await f.read(saveInput.workflowId)).version).toEqual(published.version)
    } finally { await f.close() }
  }, 30_000)

  it('rejects a branch prefix for a read-only root while retaining root-only defaults', async () => {
    const f = await setup({ sourceAccessMode: 'read-only' })
    try {
      const { saveInput } = await f.create()
      expect((await f.save(saveInput)).value.version.definition.defaultWorktree?.rootBinding)
        .toEqual(f.placement.local.rootBinding)
      expect(await f.base.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: f.workspaceId, commandId: randomUUID(), name: 'Read-only branch',
        defaultWorktree: { rootBinding: f.placement.local.rootBinding, branchPrefix: 'foreman/review' },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKTREE_ACCESS_CONFLICT') }] })
    } finally { await f.close() }
  }, 30_000)
})
