import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  canonicalGraphJson, makeWave25Fixture, RepeatWorkflowVersionV1Schema, WorkflowVersionV2Schema,
  type RepeatSaveInput,
} from '@graphql/contracts/wave25'
import { RepeatAuthoringService } from '../src/modules/repeats/authoring.js'

const fences = vi.hoisted(() => ({ live: vi.fn(), workspace: vi.fn(), save: vi.fn(), native: vi.fn() }))
vi.mock('../src/modules/access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: fences.live }))
vi.mock('../src/modules/workspaces/admission.js', () => ({ lockActiveWorkspace: fences.workspace }))
vi.mock('../src/modules/graph-drafts/saveAdmission.js', () => ({ assertMeaningfulSaveAdmitted: fences.save }))
vi.mock('../src/modules/harnesses/nativeWorkflowConfiguration.js', () => ({ assertNativeWorkflowConfiguration: fences.native }))

// Service/SQL-boundary unit tests, NOT authenticated transport or PostgreSQL proof.
function setup(semantics: 2 | 3 = 2) {
  const f = makeWave25Fixture('eng04-backend-save')
  const entry = f.version.definition.nodes[0]!.id, exit = f.version.definition.nodes[1]!.id
  const repeat = { contractVersion: 1 as const, blocks: [{ id: 'repair', nodeIds: [entry, exit],
    entryNodeId: entry, exitNodeId: exit, maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass',
    limitExit: { kind: 'branch_end' as const } }] }
  const v2 = WorkflowVersionV2Schema.parse({ ...f.version, definition: { ...f.version.definition,
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 10 },
    nodes: f.version.definition.nodes.map((node) => node.id === exit ? { ...node, choice: { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
    ] } } : node),
  } })
  const version = semantics === 2 ? v2 : RepeatWorkflowVersionV1Schema.parse({ ...v2,
    executionSemanticsVersion: 3, definition: { ...v2.definition, executionSemanticsVersion: 3, repeat } })
  const principal: ManagementPrincipal = { id: 'eng04-backend-writer', name: 'Synthetic writer', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save', 'agents:read'],
      scope: { workspaceIds: [version.workspaceId], workflowIds: [version.workflowId] } }] }
  const workflow = { record: structuredClone(version.definition), revision: '4', current_version_id: version.id, archived_at: null }
  const persisted = { record: version, execution_semantics_version: semantics, version: version.version, entry_node_id: version.entryNodeId }
  const configs = f.configurations.map((record) => ({ id: record.id, workspace_id: record.workspaceId, agent_id: record.agentId, record }))
  const inserts: unknown[][] = []
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('from workflows where')) return { rows: [workflow], rowCount: 1 }
    if (sql.includes('select record, execution_semantics_version')) return { rows: [persisted], rowCount: 1 }
    if (sql.includes('from agent_configuration_versions')) return { rows: configs, rowCount: configs.length }
    if (sql.includes('coalesce(max(version)')) return { rows: [{ next: String(version.version + 1) }], rowCount: 1 }
    if (sql.includes('insert into workflow_versions')) { inserts.push(values); return { rows: [], rowCount: 1 } }
    if (sql.includes('update workflows set')) return { rows: [{ revision: '5' }], rowCount: 1 }
    throw new Error(`Unexpected test SQL: ${sql}`)
  })
  const client = { query } as unknown as pg.PoolClient
  type Command = { authorize(client: pg.PoolClient): Promise<void>; perform(client: pg.PoolClient): Promise<unknown> }
  const execute = vi.fn(async (command: Command) => {
    await command.authorize(client)
    return { value: await command.perform(client), replayed: false }
  })
  fences.live.mockResolvedValue(principal)
  const service = new RepeatAuthoringService({} as pg.Pool, { execute } as never)
  const input: RepeatSaveInput = { workspaceId: version.workspaceId, workflowId: version.workflowId,
    commandId: 'eng04-backend-save-command', expectedRevision: 4, expectedWorkflowVersionId: version.id,
    executionSemanticsVersion: 3, repeat }
  return { f, version, principal, workflow, persisted, configs, inserts, query, execute, service, input }
}

beforeEach(() => { vi.resetAllMocks() })
describe('ENG04 backend repeat publication', () => {
  it.each([2, 3] as const)('publishes from saved semantics %i with fresh IDs/hash and exact configuration pins', async (semantics) => {
    const t = setup(semantics)
    t.input.repeat.blocks[0]!.maxOccurrences = 2
    const result = await t.service.save(t.principal, 'http', t.input)
    expect(result.replayed).toBe(false)
    expect(result.value.currentVersionId).not.toBe(t.version.id)
    expect(result.value.version.executionSemanticsVersion).toBe(3)
    expect(result.value.version.version).toBe(t.version.version + 1)
    expect(result.value.version.agentConfigurationVersionIds).toEqual(t.version.agentConfigurationVersionIds)
    expect(result.value.version.definition.repeat.blocks[0]!.maxOccurrences).toBe(2)
    expect(result.value.version.contentHash).toBe(`sha256:${createHash('sha256').update(canonicalGraphJson({
      definition: result.value.version.definition, configurations: result.value.version.agentConfigurationVersionIds,
      entryNodeId: result.value.version.entryNodeId,
    })).digest('hex')}`)
    expect(result.value.version.contentHash).not.toBe(t.version.contentHash)
    expect(t.inserts).toHaveLength(1)
    expect(fences.save).toHaveBeenCalledTimes(1)
    expect(fences.save).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: t.version.workspaceId, workflowId: t.version.workflowId, stagedAgentIds: [],
    })
    expect(fences.native).toHaveBeenCalledTimes(t.f.configurations.length)
  })

  it('preserves current labels and geometry but never executable drift', async () => {
    const t = setup(3)
    t.workflow.record.name = 'Renamed separately'
    t.workflow.record.nodes[0]!.position = { x: 133, y: 244 }
    const result = await t.service.save(t.principal, 'mcp', t.input)
    expect(result.value.version.definition.name).toBe('Renamed separately')
    expect(result.value.version.definition.nodes[0]!.position).toEqual({ x: 133, y: 244 })
    expect(t.version.definition.nodes[0]!.position).toBeUndefined()
    t.workflow.record.nodes[0]!.name = 'An unversioned executable edit'
    await expect(t.service.save(t.principal, 'mcp', t.input)).rejects.toMatchObject({ code: 'WORKFLOW_BASE_CONFLICT' })
    expect(t.inserts).toHaveLength(1)
  })

  it.each(['revision', 'version-id', 'record-scope', 'version-number', 'entry-pin', 'configuration-id', 'configuration-agent', 'configuration-missing'])('rejects %s drift before inserting a new immutable version', async (kind) => {
    const t = setup(3)
    if (kind === 'revision') t.workflow.revision = '5'
    if (kind === 'version-id') t.workflow.current_version_id = 'newer-version'
    if (kind === 'record-scope') t.persisted.record = { ...t.version, workspaceId: 'other-workspace' }
    if (kind === 'version-number') t.persisted.version++
    if (kind === 'entry-pin') t.persisted.entry_node_id = 'other-entry'
    if (kind === 'configuration-id') t.configs[0]!.id = 'other-configuration'
    if (kind === 'configuration-agent') t.configs[0]!.agent_id = 'other-agent'
    if (kind === 'configuration-missing') t.configs.pop()
    await expect(t.service.save(t.principal, 'http', t.input)).rejects.toBeTruthy()
    expect(t.inserts).toHaveLength(0)
  })

  it('retains the common unsettled-Run barrier and makes no publication after it rejects', async () => {
    const t = setup()
    fences.save.mockRejectedValueOnce(new Error('unsettled native cleanup'))
    await expect(t.service.save(t.principal, 'http', t.input)).rejects.toThrow('unsettled native cleanup')
    expect(t.inserts).toHaveLength(0)
    expect(t.query.mock.calls.some(([sql]) => sql.includes('agent_configuration_versions'))).toBe(false)
  })

  it('denies revoked live grants before reading or publishing; does not rely on the stale argument', async () => {
    const t = setup()
    fences.live.mockResolvedValueOnce({ ...t.principal, grants: [] })
    await expect(t.service.save(t.principal, 'mcp', t.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(t.query).not.toHaveBeenCalled()
  })

  it('denies unreadable pinned Agents and refuses malformed capability scope', async () => {
    const t = setup()
    const restricted = { ...t.principal, grants: t.principal.grants.map((grant) => ({ ...grant,
      actions: grant.actions.filter((action) => action !== 'agents:read'),
    })) }
    fences.live.mockResolvedValueOnce(restricted)
    await expect(t.service.save(restricted, 'mcp', t.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(t.inserts).toHaveLength(0)
    expect(() => t.service.capabilities(t.principal, { workflowId: t.version.workflowId })).toThrow()
  })

  it('refuses unsupported nullable/mode client payloads before command reservation', async () => {
    const t = setup()
    await expect(t.service.save(t.principal, 'http', { ...t.input, repeat: null } as never)).rejects.toBeTruthy()
    await expect(t.service.save(t.principal, 'http', { ...t.input, mode: 'repeat' } as never)).rejects.toBeTruthy()
    expect(t.execute).not.toHaveBeenCalled()
  })
})
