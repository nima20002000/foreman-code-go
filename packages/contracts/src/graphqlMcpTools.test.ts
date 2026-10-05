import { OperatorToolNameSchema } from './management/index.js'
import { describe, expect, it } from 'vitest'
import { AgentSchema } from './index.js'
import { effectiveGraphqlTools, graphqlRoleTools, graphqlToolRoles, GraphqlToolOverrideSchema, GRAPHQL_OPERATOR_TOOLS } from './graphqlMcpTools.js'
import { CurrentWorkflowNodeSchema } from './wave25/workflowShape.js'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES } from './workerNativeOutput.js'

describe('Foreman Code MCP tools per Agent', () => {
  it('starts from every role tool, applies the Agent default, then the node override, never beyond the role', () => {
    const outputs = Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES)
    expect(graphqlRoleTools('coder')).toEqual(['context_get', 'interaction_list', 'interaction_get', ...outputs])
    expect(effectiveGraphqlTools('coder')).toEqual(['context_get', 'interaction_list', 'interaction_get', ...outputs])
    expect(effectiveGraphqlTools('coder', ['context_get'])).toEqual(['context_get'])
    expect(effectiveGraphqlTools('coder', ['context_get'], { add: ['interaction_get'], remove: ['context_get'] })).toEqual(['interaction_get'])
    expect(effectiveGraphqlTools('coder', [], { add: ['interaction_respond'], remove: [] })).toEqual([])
    expect(effectiveGraphqlTools('orchestrator', [], { add: ['interaction_respond'], remove: [] })).toEqual(['interaction_respond'])
    expect(graphqlToolRoles('interaction_respond')).toEqual(['operator', 'orchestrator'])
  })
  it('keeps workflow output settings within Agent roles and honors explicit defaults and node removals', () => {
    const outputs = Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES)
    for (const tool of outputs) {
      expect(graphqlToolRoles(tool)).toEqual(['orchestrator', 'coder'])
      expect(GraphqlToolOverrideSchema.parse({ add: [tool], remove: [] }).add).toEqual([tool])
      expect(effectiveGraphqlTools('coder', ['context_get'], { add: [tool], remove: [] }))
        .toEqual(['context_get', tool])
    }
    expect(effectiveGraphqlTools('coder', outputs, { add: [], remove: outputs })).toEqual([])
  })

  it('accepts only known Agent tools, without overlap', () => {
    expect(AgentSchema.shape.graphqlTools.safeParse(['workflow_create']).success).toBe(false)
    expect(AgentSchema.shape.graphqlTools.safeParse(['context_get', 'context_get']).success).toBe(false)
    expect(GraphqlToolOverrideSchema.safeParse({ add: ['context_get'], remove: ['context_get'] }).success).toBe(false)
    expect(CurrentWorkflowNodeSchema.safeParse({ id: 'n', agentId: 'a', name: 'N', graphqlTools: { add: ['interaction_get'], remove: [] } }).success).toBe(true)
  })
})

it('requires both grants for protected root adoption and keeps it out of Agent tools', () => {
  const name = 'workspace_root_configuration_adopt', tool = GRAPHQL_OPERATOR_TOOLS[name]
  expect(OperatorToolNameSchema.parse(name)).toBe(name)
  expect(tool.actions).toEqual(['source_roots:bind', 'workspace_locations:update'])
  expect(tool.scope).toBe('workspace')
  expect(tool.readOnly).toBe(false)
  expect(graphqlToolRoles(name)).toEqual(['operator'])
  expect(AgentSchema.shape.graphqlTools.safeParse([name]).success).toBe(false)
  expect(GraphqlToolOverrideSchema.safeParse({ add: [name], remove: [] }).success).toBe(false)
})
