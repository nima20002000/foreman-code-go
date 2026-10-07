import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'

import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { DEFAULT_HARNESS_DEFAULTS, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES } from '@foreman-code/contracts/worker-native-output'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { nativeOpenCodeMcpToolName } from '../src/modules/harnesses/openCodePermissionPolicy.js'

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
    .toEqual(['context_get', 'interaction_list', 'interaction_get', 'ci_run', 'ci_get'])
  const row = { role: 'coder', defaults: null, override: null, purpose: 'workflow', local_outputs: true,
    artifact_outputs: { version: 1, outputKeys: ['report'] },
    harness: { ...DEFAULT_HARNESS_DEFAULTS.opencode, nativeAgent: 'build', advanced: {
      ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: APP_MCP_SERVER_NAMES.flatMap(name => [
        { permission: nativeOpenCodeMcpToolName('files.native_output_*', name), pattern: '*', effect: 'ask' as const },
        { permission: nativeOpenCodeMcpToolName(WORKER_NATIVE_OUTPUT_TOOL_NAMES.publish, name),
          pattern: '*', effect: 'deny' as const },
      ]),
    } } }
  query.mockResolvedValueOnce({ rows: [row] })
  expect((await service.context(worker) as { tools: string[] }).tools)
    .toEqual(['context_get', 'interaction_list', 'interaction_get', ...outputs.slice(0, 3), 'ci_run', 'ci_get'])
  query.mockResolvedValueOnce({ rows: [{ ...row, override: { add: [], remove: [outputs[0]] } }] })
  expect((await service.context(worker) as { tools: string[] }).tools)
    .toEqual(['context_get', 'interaction_list', 'interaction_get', ...outputs.slice(1, 3), 'ci_run', 'ci_get'])
  for (const changed of [{ ...row, harness: { ...row.harness, nativeAgent: 'plan' } },
    { ...row, harness: DEFAULT_HARNESS_DEFAULTS.codex }, { ...row, purpose: 'reviewer' },
    { ...row, local_outputs: false },
    { ...row, defaults: ['context_get'] }]) {
    query.mockResolvedValueOnce({ rows: [changed] })
    expect((await service.context(worker) as { tools: string[] }).tools.filter(tool => outputs.includes(tool as never)))
      .toEqual([])
  }
})

it('tells the Agent which worktree and branch it owns', async () => {
  const query = vi.fn(async (text: string): Promise<{ rows: unknown[] }> => text.includes('execution_native_placements')
    ? { rows: [{ worktree: { repository: 'octo/site', branch: 'foreman/review/coder-1a2b3c4d', commit: 'a'.repeat(40) },
      path: '/home/agent/project/2c1d/tree' }] }
    : { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] })
  const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never)
  expect((await service.context(worker) as { worktree?: unknown }).worktree).toEqual({ repository: 'octo/site',
    branch: 'foreman/review/coder-1a2b3c4d', baseCommit: 'a'.repeat(40), path: '/home/agent/project/2c1d/tree' })
  query.mockImplementation(async () => ({ rows: [{ role: 'coder', defaults: ['context_get'], override: null }] }))
  expect(await service.context(worker)).not.toHaveProperty('worktree')
})

it('tells the Agent where its workspace Google Drive folder is mounted on its own computer', async () => {
  const deviceId = '22222222-2222-4222-8222-222222222222'
  const query = vi.fn(async (text: string): Promise<{ rows: unknown[] }> => text.includes('workspaces w')
    ? { rows: [{ device_id: deviceId, name: 'Cross/computer team' }] }
    : text.includes('execution_native_placements') ? { rows: [] }
      : { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] })
  const mounts: unknown[] = []
  const service = Object.assign(new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never), {
    driveMount: async (hostRef: unknown) => { mounts.push(hostRef); return mounts.length === 1 ? '/home/dexter/Foreman Code Drive' : null } })
  expect((await service.context(worker) as { sharedFiles?: unknown }).sharedFiles).toEqual({ provider: 'google-drive',
    path: '/home/dexter/Foreman Code Drive/Cross-computer team' })
  expect(mounts).toEqual([{ kind: 'device', deviceId }])
  // No Drive mounted on that computer: no shared folder is offered.
  expect(await service.context(worker)).not.toHaveProperty('sharedFiles')
})
