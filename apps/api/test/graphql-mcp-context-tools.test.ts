import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'

import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { DEFAULT_HARNESS_DEFAULTS, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION } from '@graphql/contracts'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES } from '@graphql/contracts/worker-native-output'

const scope = { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] }
const worker: ManagementPrincipal = { id: 'worker-1', name: 'Worker', audience: 'worker', agentId: 'agent-1',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [{ actions: ['interactions:read'], scope }] }

it('advertises only the interaction capabilities whose tools are enabled for the Agent and node', async () => {
  // The Coder's pinned configuration allows only context_get; the node adds nothing.
  const query = vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [{ role: 'coder', defaults: ['context_get'], override: null }] }))
  const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never)
  const context = await service.context(worker) as { tools: string[]; capabilities: Record<string, boolean> }
  expect(context.tools).toEqual(['context_get'])
  expect(context.capabilities).toEqual({ contextGet: true, interactionList: false, interactionGet: false, interactionRespond: false })
  query.mockResolvedValueOnce({ rows: [{ role: 'coder', defaults: ['context_get'], override: { add: ['interaction_get'], remove: [] } }] })
  expect((await service.context(worker) as { capabilities: Record<string, boolean> }).capabilities)
    .toMatchObject({ interactionList: false, interactionGet: true })
})

it('advertises only declared OpenCode output tools permitted by the pinned settings and node', async () => {
  const outputs = Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES)
  const query = vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [{ role: 'coder', defaults: null,
    override: null, harness: DEFAULT_HARNESS_DEFAULTS.opencode, artifact_outputs: null, purpose: 'workflow' }] }))
  const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never)
  expect((await service.context(worker) as { tools: string[] }).tools)
    .toEqual(['context_get', 'interaction_list', 'interaction_get'])
  const row = { role: 'coder', defaults: null, override: null, purpose: 'workflow', local_outputs: true,
    artifact_outputs: { version: 1, outputKeys: ['report'] },
    harness: { ...DEFAULT_HARNESS_DEFAULTS.opencode, nativeAgent: 'build', advanced: {
      ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: [
        { permission: 'graphql_files_native_output_*', pattern: '*', effect: 'ask' },
        { permission: 'graphql_files_native_output_publish', pattern: '*', effect: 'deny' },
      ],
    } } }
  query.mockResolvedValueOnce({ rows: [row] })
  expect((await service.context(worker) as { tools: string[] }).tools)
    .toEqual(['context_get', 'interaction_list', 'interaction_get', ...outputs.slice(0, 3)])
  query.mockResolvedValueOnce({ rows: [{ ...row, override: { add: [], remove: [outputs[0]] } }] })
  expect((await service.context(worker) as { tools: string[] }).tools)
    .toEqual(['context_get', 'interaction_list', 'interaction_get', ...outputs.slice(1, 3)])
  for (const changed of [{ ...row, harness: { ...row.harness, nativeAgent: 'plan' } },
    { ...row, harness: DEFAULT_HARNESS_DEFAULTS.codex }, { ...row, purpose: 'reviewer' },
    { ...row, local_outputs: false },
    { ...row, defaults: ['context_get'] }]) {
    query.mockResolvedValueOnce({ rows: [changed] })
    expect((await service.context(worker) as { tools: string[] }).tools.filter(tool => outputs.includes(tool as never)))
      .toEqual([])
  }
})
