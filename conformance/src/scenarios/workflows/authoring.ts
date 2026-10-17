import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CurrentManagedWorkflowCommandResultSchema, CurrentWorkflowCreateInputSchema,
  CurrentWorkflowReadResultSchema, WorkflowDefinitionV3Schema,
  makeCurrentWorkflowFixture, type CurrentFixtureForm, type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import type { CodexHarnessConfiguration } from '@foreman-code/contracts'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import { createWorkspace } from '../smoke/support.js'
import { createCodexAgent } from './agents.js'
import { workflowDigest } from './digest.js'

export interface ExecutableWorkflowOptions {
  name: string
  form?: CurrentFixtureForm
  configuration?: CodexHarnessConfiguration
  initialPrompt?: string
  configureGraph?(definition: WorkflowDefinitionV3): WorkflowDefinitionV3
}

/** All identities and immutable pins are accepted by the public authoring API. */
export async function createExecutableWorkflow(ctx: ScenarioContext, options: ExecutableWorkflowOptions) {
  const { created: workspace } = await createWorkspace(ctx, options.name, ctx.scenarioDirectory)
  const workspaceId = workspace.workspace.id
  const fixture = makeCurrentWorkflowFixture(randomUUID(), options.form ?? 'single')
  const agents: Awaited<ReturnType<typeof createCodexAgent>>[] = []
  for (const node of fixture.version.definition.nodes) {
    agents.push(await createCodexAgent(ctx, workspaceId, { id: node.agentId, name: node.name,
      ...(options.configuration === undefined ? {} : { configuration: options.configuration }) }))
  }
  const agentPins = Object.fromEntries(agents.map(({ agent }) => {
    assert.ok(agent.configurationVersionId)
    return [agent.id, agent.configurationVersionId]
  }))
  const graph = WorkflowDefinitionV3Schema.parse({
    ...fixture.version.definition,
    nodes: fixture.version.definition.nodes.map(node => ({ ...node,
      initialPrompt: options.initialPrompt ?? 'Return the deterministic conformance answer.' })),
  })
  const configured = options.configureGraph?.(graph) ?? graph
  const initialGraph = CurrentWorkflowCreateInputSchema.shape.initialSave.unwrap()
    .shape.graph.strip().parse(configured)
  const input = CurrentWorkflowCreateInputSchema.parse({
    workspaceId, commandId: randomUUID(), name: options.name, executionSemanticsVersion: 3,
    defaultWorktree: null, initialSave: { graph: initialGraph, expectedAgentConfigurationVersionIds: agentPins },
  })
  const workflowsPath = `/api/management/workspaces/${workspaceId}/workflows`
  const response = await ctx.http.request('POST', workflowsPath, { body: input })
  const { value: workflow } = CurrentManagedWorkflowCommandResultSchema.parse(response.body)
  assertResponse(response, { status: 201, body: {
    value: {
      workflow: { ...initialGraph, id: '<id>', workspaceId, name: options.name, version: 1,
        createdAt: '<timestamp>', updatedAt: '<timestamp>' },
      revision: 2, currentVersionId: '<id>', archivedAt: null,
    }, replayed: false,
  } }, [
    { pointer: '/body/value/workflow/id', kind: 'id' },
    { pointer: '/body/value/workflow/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/workflow/updatedAt', kind: 'timestamp' },
    { pointer: '/body/value/currentVersionId', kind: 'id' },
  ])
  const workflowId = workflow.workflow.id
  const definitionPath = `${workflowsPath}/${workflowId}/definition`
  const read = await ctx.http.request('GET', definitionPath)
  const saved = CurrentWorkflowReadResultSchema.parse(read.body)
  const contentHash = workflowDigest({ definition: workflow.workflow,
    configurations: agentPins, entryNodeId: initialGraph.entryNodeId })
  assertResponse(read, { status: 200, body: {
    workspaceId, workflowId, revision: 2, currentVersionId: workflow.currentVersionId,
    version: { id: workflow.currentVersionId, workspaceId, workflowId, version: 1,
      executionSemanticsVersion: 3, entryNodeId: initialGraph.entryNodeId,
      definition: workflow.workflow, agentConfigurationVersionIds: agentPins,
      approval: initialGraph.approval, contentHash, createdAt: workflow.workflow.updatedAt },
  } })
  for (const agent of agents) {
    assertResponse(await ctx.http.request('GET', `/api/management/workspaces/${workspaceId}/agents/${agent.agent.id}`), {
      status: 200, body: { ...agent, archivedAt: null, workflowIds: [workflowId] },
    })
  }
  return { workspace, workflow, saved, agents, definitionPath }
}

export type ExecutableWorkflow = Awaited<ReturnType<typeof createExecutableWorkflow>>
