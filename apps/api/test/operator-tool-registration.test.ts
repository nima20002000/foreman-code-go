import { CURRENT_WORKFLOW_TOOLS } from '@foreman-code/contracts/wave25'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  ManagementActionSchema,
  type ManagementAction,
  type ManagementGrant,
  type ManagementPrincipal,
  type OperatorToolName,
} from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedPromptSettingSchema, PromptSettingUpdateResultSchema } from '@foreman-code/contracts/management'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

import { registerAgentTools } from '../src/mcp/operator/tools/agents.js'
import { registerHarnessTools } from '../src/mcp/operator/tools/harnesses.js'
import { registerInteractionTools } from '../src/mcp/operator/tools/interactions.js'
import { registerRunTools } from '../src/mcp/operator/tools/runs.js'
import { registerSettingsTools } from '../src/mcp/operator/tools/settings.js'
import { registerWorkflowTools } from '../src/mcp/operator/tools/workflows.js'
import { registerWorkspaceDefaultsTools } from '../src/mcp/operator/tools/workspaceDefaults.js'
import { registerWorkspaceTools } from '../src/mcp/operator/tools/workspaces.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'

// Independent expectations, not generated from the production permission catalog.
const actionTools: Array<[ManagementAction, OperatorToolName[]]> = [
  ['agents:read', ['agent_get', 'agent_list']],
  ['graph:read', []],
  ['graph:edit', []],
  ['graph:save', []],
  ['harnesses:read', ['claude_setup_options_get', 'harness_get', 'harness_list']],
  ['harnesses:update', ['harness_defaults_update']],
  ['interactions:read', ['interaction_get', 'interaction_list', 'interaction_summary']],
  ['runs:read', ['run_activities_get_v1', 'run_events_list', 'run_get', 'run_list']],
  ['runs:stop', ['run_stop']],
  ['settings:read', [
    'agent_defaults_get', 'general_settings_get', 'operator_initial_prompt_get',
    'system_prompt_get', 'workflow_defaults_get', 'workspace_defaults_get',
  ]],
  ['settings:update', [
    'agent_defaults_update', 'general_settings_update', 'operator_initial_prompt_update',
    'system_prompt_update', 'workflow_defaults_update', 'workspace_defaults_update',
  ]],
  ['workflows:read', ['workflow_get', 'workflow_list']],
  ['workflows:create', ['workflow_create']],
  ['workflows:update', ['workflow_update']],
  ['workflows:archive', ['workflow_archive', 'workflow_batch_archive']],
  ['workspaces:read', ['workspace_get', 'workspace_list']],
  ['workspaces:create', ['workspace_create']],
  ['workspaces:update', ['workspace_update']],
  ['workspaces:archive', ['workspace_archive', 'workspace_batch_archive']],
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
    services: { settings: {}, interactions: {}, runs: {}, workflows: {} },
  } as unknown as OperatorRequestContext
}

function registered(context: OperatorRequestContext): string[] {
  const names: string[] = []
  const server = { registerTool: (name: string) => { names.push(name) } } as unknown as McpServer
  for (const register of [registerAgentTools, registerHarnessTools,
    registerInteractionTools, registerRunTools, registerSettingsTools,
    registerWorkflowTools, registerWorkspaceTools, registerWorkspaceDefaultsTools]) {
    register(server, context)
  }
  return names.sort()
}

describe('Operator tool registration permissions', () => {
  it.each([
    ['system_prompt_get', 'system_prompt_update'],
    ['operator_initial_prompt_get', 'operator_initial_prompt_update'],
  ] as const)('persists %s settings through authenticated MCP and denies read-only updates', async (readTool, updateTool) => {
    const database = await reviewAuthMcpDatabase({ hostProfiles: false })
    try {
      const expiresAt = new Date(Date.now() + 600_000)
      const owner = await database.access.issue({ name: 'Settings owner', audience: 'operator', expiresAt,
        grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
      const reader = await database.access.issue({ name: 'Settings reader', audience: 'operator', expiresAt,
        grants: [{ actions: ['settings:read'], scope: {} }] })
      const writeClient = await database.connect(owner.token)
      const readClient = await database.connect(reader.token)
      const input = { value: { text: 'Stored prompt' }, expectedRevision: 0, commandId: randomUUID() }
      const saved = PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await writeClient.callTool({
        name: updateTool, arguments: input,
      })))
      expect(saved).toMatchObject({ value: { value: input.value, revision: 1 }, replayed: false })
      const replay = PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await writeClient.callTool({
        name: updateTool, arguments: input,
      })))
      expect(replay).toEqual({ ...saved, replayed: true })
      const denied = await readClient.callTool({ name: updateTool,
        arguments: { ...input, commandId: randomUUID(), expectedRevision: 1, value: { text: 'Denied edit' } } })
      expect(denied.isError).toBe(true)
      const readback = ManagedPromptSettingSchema.parse(decodeMcpToolResult(await readClient.callTool({
        name: readTool, arguments: {},
      })))
      expect(readback).toEqual(saved.value)
      const persisted = readTool === 'system_prompt_get'
        ? await database.repository.getSystemPrompt() : await database.repository.getOperatorInitialPrompt()
      expect(persisted).toEqual(saved.value)
    } finally {
      await database.close()
    }
  })

  it.each(actionTools)('registers only the tools allowed by %s', (action, expected) => {
    expect(registered(context([{ actions: [action], scope: {} }]))).toEqual(expected)
  })

  it('registers every supported tool for an unrestricted owner', () => {
    // These require more than one grant (respond also needs interactions:read).
    const expected = [...actionTools.flatMap(([, names]) => names), 'interaction_respond', 'run_handoffs_get_v1', 'run_start'].sort()
    expect(registered(context([{ actions: [...ManagementActionSchema.options], scope: {} }]))).toEqual(expected)
  })

  it('registers current V3 authoring with complete grants and hides retired graph tools', () => {
    const candidate = context([{ actions: [...ManagementActionSchema.options], scope: {} }])
    candidate.services.workflows = { current: {} } as OperatorRequestContext['services']['workflows']
    const names = registered(candidate)
    for (const name of Object.values(CURRENT_WORKFLOW_TOOLS)) expect(names).toContain(name)
    expect(names).not.toContain('graph_save')
    expect(names).not.toContain('graph_draft_apply')
    expect(names).not.toContain('run_history_get_v1')
  })

  it('does not advertise V3 Save when graph write and read grants have disjoint scopes', () => {
    const candidate = context([
      { actions: ['workflows:read', 'agents:read', 'graph:read', 'workspace_locations:read'], scope: { workspaceIds: ['a'] } },
      { actions: ['workflows:update', 'graph:edit', 'graph:save'], scope: { workspaceIds: ['b'] } },
    ])
    candidate.services.workflows = { current: {} } as OperatorRequestContext['services']['workflows']
    expect(registered(candidate)).toContain(CURRENT_WORKFLOW_TOOLS.validate)
    expect(registered(candidate)).not.toContain(CURRENT_WORKFLOW_TOOLS.save)
    expect(registered(candidate)).not.toContain(CURRENT_WORKFLOW_TOOLS.edits)
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
