import type { McpServer } from '@modelcontextprotocol/server'
import {
  ManagementActionSchema,
  type ManagementAction,
  type ManagementGrant,
  type ManagementPrincipal,
  type OperatorToolName,
} from '@graphql/contracts/management'
import { describe, expect, it } from 'vitest'

import { registerAgentTools } from '../src/mcp/operator/tools/agents.js'
import { registerGraphTools } from '../src/mcp/operator/tools/graph.js'
import { registerHarnessTools } from '../src/mcp/operator/tools/harnesses.js'
import { registerInteractionTools } from '../src/mcp/operator/tools/interactions.js'
import { registerRunTools } from '../src/mcp/operator/tools/runs.js'
import { registerSettingsTools } from '../src/mcp/operator/tools/settings.js'
import { registerWorkflowTools } from '../src/mcp/operator/tools/workflows.js'
import { registerWorkspaceTools } from '../src/mcp/operator/tools/workspaces.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'

// Independent expectations, not generated from the production permission catalog.
const actionTools: Array<[ManagementAction, OperatorToolName[]]> = [
  ['agents:read', ['agent_get', 'agent_list']],
  ['graph:read', ['graph_draft_get', 'graph_draft_open', 'graph_validate']],
  ['graph:edit', ['graph_draft_apply', 'graph_draft_discard']],
  ['graph:save', ['graph_save']],
  ['harnesses:read', ['harness_get', 'harness_list']],
  ['harnesses:update', ['harness_defaults_update']],
  ['interactions:read', ['interaction_get', 'interaction_list', 'interaction_summary']],
  ['interactions:respond', ['interaction_respond']],
  ['runs:read', ['run_events_list', 'run_get', 'run_list']],
  ['runs:stop', ['run_stop']],
  ['settings:read', ['agent_defaults_get', 'workflow_defaults_get']],
  ['settings:update', ['agent_defaults_update', 'workflow_defaults_update']],
  ['workflows:read', ['workflow_get', 'workflow_list']],
  ['workflows:create', ['workflow_create']],
  ['workflows:update', ['workflow_update']],
  ['workflows:archive', ['workflow_archive']],
  ['workspaces:read', ['workspace_get', 'workspace_list']],
  ['workspaces:create', ['workspace_create']],
  ['workspaces:update', ['workspace_update']],
  ['workspaces:archive', ['workspace_archive']],
  ['workspace_locations:validate', ['workspace_location_validate']],
  ['workspace_locations:update', ['workspace_location_set']],
]

function context(grants: ManagementGrant[] = []): OperatorRequestContext {
  return {
    principal: {
      id: 'registration-reader', name: 'Registration reader', audience: 'operator',
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants,
    },
    // No service callback is executed in these registration-only tests.
    services: { settings: {}, interactions: {} },
  } as unknown as OperatorRequestContext
}

function registered(context: OperatorRequestContext): string[] {
  const names: string[] = []
  const server = { registerTool: (name: string) => { names.push(name) } } as unknown as McpServer
  for (const register of [registerAgentTools, registerGraphTools, registerHarnessTools,
    registerInteractionTools, registerRunTools, registerSettingsTools,
    registerWorkflowTools, registerWorkspaceTools]) {
    register(server, context)
  }
  return names.sort()
}

describe('Operator tool registration permissions', () => {
  it.each(actionTools)('registers only the tools allowed by %s', (action, expected) => {
    expect(registered(context([{ actions: [action], scope: {} }]))).toEqual(expected)
  })

  it('registers every supported tool for an unrestricted owner', () => {
    const expected = [...actionTools.flatMap(([, names]) => names), 'run_start'].sort()
    expect(registered(context([{ actions: [...ManagementActionSchema.options], scope: {} }]))).toEqual(expected)
  })

  it('does not register tools without grants', () => {
    expect(registered(context())).toEqual([])
  })

  it.each([
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { revokedAt: '2026-01-01T00:00:00.000Z' },
    { audience: 'worker' as const },
    { audience: 'user' as const },
  ])('rejects an inactive or non-Operator principal: %j', (patch) => {
    const candidate = context([{ actions: [...ManagementActionSchema.options], scope: {} }])
    candidate.principal = { ...candidate.principal, ...patch } as ManagementPrincipal
    expect(registered(candidate)).toEqual([])
  })

  it('still validates malformed stored grant scopes', () => {
    const candidate = context([{ actions: ['agents:read'], scope: {} }])
    candidate.principal.grants[0]!.scope = { workspaceIds: 'workspace-a' } as unknown as ManagementGrant['scope']
    expect(() => registered(candidate)).toThrow()
  })

  it('does not turn workspace-scoped grants into global settings or harness access', () => {
    expect(registered(context([{
      actions: ['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update', 'workspaces:create', 'agents:read'],
      scope: { workspaceIds: ['workspace-a'] },
    }]))).toEqual(['agent_get', 'agent_list'])
  })

  it('keeps empty scopes from advertising resource access', () => {
    expect(registered(context([{ actions: ['agents:read'], scope: { workspaceIds: [] } }]))).toEqual([])
  })

  it.each(([
    [{ actions: ['runs:start'], scope: { workspaceIds: ['a'] } }],
    [{ actions: ['workspace_locations:read'], scope: { workspaceIds: ['a'] } }],
    [
      { actions: ['runs:start'], scope: { workspaceIds: ['a'] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: ['b'] } },
    ],
  ] satisfies ManagementGrant[][]).map((grants) => ({ grants })))('requires compatible run-start and location grants: $grants', ({ grants }) => {
    expect(registered(context(grants))).toEqual([])
  })

  it('registers run-start when both grants cover the same workspace', () => {
    expect(registered(context([
      { actions: ['runs:start'], scope: { workspaceIds: ['a'], workflowIds: ['workflow-a'] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: ['a'] } },
    ]))).toEqual(['run_start'])
  })

  it('does not register tools for absent optional services', () => {
    const candidate = context([{ actions: ['settings:read', 'settings:update', 'interactions:read', 'interactions:respond'], scope: {} }])
    delete candidate.services.settings
    delete candidate.services.interactions
    expect(registered(candidate)).toEqual([])
  })
})
