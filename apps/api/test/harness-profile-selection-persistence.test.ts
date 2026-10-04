import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, AgentSchema, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import { AgentCreateInputSchema, AgentUpdateInputSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { configurationInput, saveAgentConfiguration } from '../src/modules/workspaces/agentConfiguration.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import type { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { acceptOperatorConfiguration } from '../src/modules/conversations/operatorAcceptedConfiguration.js'
import type { OperatorConfigurationVersion } from '@foreman-code/contracts'

const mainId = randomUUID()
const selection = { instanceId: randomUUID(), instanceRevision: '3', target: { hostRef: { kind: 'main' as const, mainId },
  applicationInstallationId: mainId, harnessInstallationId: 'codex-install', installationFingerprint: 'actual-install' } }
const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null, expiresAt: '9999-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read'], scope: {} }] }
const configuration = DEFAULT_HARNESS_DEFAULTS.codex
function selectionService() {
  const value: HostHarnessOverride = { ...selection, revision: 3, presetId: 'preset', enabled: true, driverId: 'codex', configuration: withAdvancedDefaults(configuration),
    configurationFingerprint: commandInputHash(withAdvancedDefaults(configuration)), qualification: 'unqualified' }
  const authorize = vi.fn(async () => {})
  const repository = { latest: vi.fn(async () => value), lockRevision: vi.fn(async () => {}) } as unknown as HarnessInstanceSettingsRepository
  const service = new HostHarnessOverrideService(repository, {} as PostgresCommandCoordinator, { authorize }, async () => null)
  return { value, authorize, repository, service }
}
describe('explicit chat profile configuration producer', () => {
  it('validates actual live host grant and exact current instance/config on the command client', async () => {
    const f = selectionService(); const client = {} as pg.PoolClient
    await f.service.validateSelection(principal, selection, configuration, client)
    expect(f.authorize).toHaveBeenCalledWith(principal, 'harnesses:read', selection.target.hostRef, mainId, client)
    expect(f.repository.latest).toHaveBeenCalledWith(client, selection.instanceId)
    for (const candidate of [{ ...selection, instanceRevision: '2' }, { ...selection, target: { ...selection.target, applicationInstallationId: randomUUID() } }]) {
      await expect(f.service.validateSelection(principal, candidate, configuration, client)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
    }
    await expect(f.service.validateSelection(principal, selection, { ...configuration, model: 'changed' }, client)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
    f.authorize.mockRejectedValue(new Error('revoked'))
    await expect(f.service.validateSelection(principal, selection, configuration, client)).rejects.toThrow('revoked')
  })
  it('strict MCP create/update schema retains the exact selector', () => {
    expect(AgentCreateInputSchema.parse({ workspaceId: 'w', commandId: 'command-create', agentId: 'a', name: 'A', configuration, harnessProfileSelection: selection }).harnessProfileSelection).toEqual(selection)
    expect(AgentUpdateInputSchema.parse({ workspaceId: 'w', commandId: 'command-update', agentId: 'a', expectedRevision: 1,
      expectedConfigurationVersionId: 'v1', harnessProfileSelection: selection }).harnessProfileSelection).toEqual(selection)
  })
  it('executes the actual MCP Agent create producer with authorized selected-profile validation and no API-host native probe', async () => {
    const versions: unknown[] = []
    const client = { query: vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.includes('insert into agent_configuration_versions')) versions.push(JSON.parse(String(args![4])))
      return { rows: sql.includes('select archived_at from workspaces') ? [{ archived_at: null }]
        : sql.startsWith('select metadata_revision') ? [{ metadata_revision: '1' }]
        : sql.includes('coalesce(max(version)') ? [{ next_version: 1 }] : [] }
    }) } as unknown as pg.PoolClient
    const execute = vi.fn(async (command: { perform: (client: pg.PoolClient) => Promise<unknown> }) => ({ value: await command.perform(client), replayed: false }))
    const qualifyConfiguration = vi.fn(async () => { throw new Error('local probe forbidden') })
    const validateSelection = vi.fn(async () => {})
    const service = new OperatorAgentMutationService({} as pg.Pool, { execute } as unknown as PostgresCommandCoordinator,
      { qualifyConfiguration } as never, { validateSelection })
    const creator = { ...principal, grants: [{ actions: ['agents:create' as const, 'agents:read' as const, 'harnesses:read' as const], scope: {} }] }
    const input = { workspaceId: 'workspace', commandId: 'create-command', agentId: 'agent', name: 'A', configuration,
      productRole: 'coder' as const, harnessProfileSelection: selection }
    const saved = await service.create(creator, input)
    expect(saved.value).toMatchObject({ agent: { harnessProfileSelection: selection } })
    expect(versions[0]).toMatchObject({ harnessProfileSelection: selection })
    expect(validateSelection).toHaveBeenCalledWith(creator, selection, expect.objectContaining({ harness: 'codex' }), client)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ source: 'mcp', operation: 'agent.create' }))
    expect(qualifyConfiguration).not.toHaveBeenCalled()
    validateSelection.mockRejectedValue(new Error('revoked host'))
    await expect(service.create(creator, { ...input, commandId: 'denied-command', agentId: 'denied' })).rejects.toThrow('revoked host')
    expect(versions).toHaveLength(1)
  })
  it('stores and reads profile metadata in the actual immutable Agent record and includes it in content hash', async () => {
    const inserted: unknown[] = []; const agents: unknown[] = []
    const client = { query: vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.includes('insert into agent_configuration_versions')) inserted.push(JSON.parse(String(args![4])))
      if (sql.includes('update agents')) agents.push(JSON.parse(String(args![2])))
      return { rows: sql.includes('coalesce(max(version)') ? [{ next_version: 1 }] : [] }
    }) } as unknown as pg.PoolClient
    const input = AgentSchema.parse({ id: 'agent', name: 'A', harnessConfiguration: configuration, harnessProfileSelection: selection })
    const validate = vi.fn(async () => {})
    const saved = await saveAgentConfiguration(client, 'workspace', input, false, validate)
    expect(saved.harnessProfileSelection).toEqual(selection)
    expect(AgentConfigurationVersionSchema.parse(inserted[0]).harnessProfileSelection).toEqual(selection)
    expect(AgentSchema.parse(agents[0]).harnessProfileSelection).toEqual(selection)
    expect(validate).toHaveBeenCalledWith(selection, expect.objectContaining({ harness: 'codex' }), client)
    const without = configurationInput('workspace', { id: 'agent', name: 'A', harnessConfiguration: configuration })
    expect(without.harnessProfileSelection).toBeUndefined()
    expect(configurationInput('workspace', input).harnessProfileSelection).toEqual(selection)
    await expect(saveAgentConfiguration(client, 'workspace', input)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_UNAVAILABLE' })
  })
  it('validates and persists selected role defaults through the shared management command without local qualification', async () => {
    const client = {} as pg.PoolClient
    const value = { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harnessProfileSelection: selection } }
    const update = vi.fn(async (_client: pg.PoolClient, next: unknown) => ({ value: next, revision: 2 }))
    const settings = { getAgentDefaults: async () => ({ value: DEFAULT_AGENT_DEFAULTS, revision: 1 }), updateManagedAgentDefaults: update } as unknown as PostgresFoundationSettingsRepository
    const commands = { execute: async (command: { perform: (client: pg.PoolClient) => Promise<unknown> }) => ({ value: await command.perform(client), replayed: false }) } as unknown as PostgresCommandCoordinator
    const qualifyConfiguration = vi.fn(async () => { throw new Error('unexpected local probe') })
    const validateSelection = vi.fn(async () => {})
    const service = new FoundationSettingsManagementService(settings, commands, { qualifyConfiguration } as never, undefined, { validateSelection })
    const writer = { ...principal, grants: [{ actions: ['settings:update' as const, 'harnesses:read' as const], scope: {} }] }
    const result = await service.updateAgentDefaults(writer, 'mcp', { commandId: 'command-default', expectedRevision: 1, value })
    expect(result.value).toMatchObject({ value: { operator: { harnessProfileSelection: selection } } })
    expect(validateSelection).toHaveBeenCalledWith(writer, selection, value.operator.harness, client)
    expect(qualifyConfiguration).not.toHaveBeenCalled()
    validateSelection.mockRejectedValue(new Error('foreign installation'))
    await expect(service.updateAgentDefaults(writer, 'mcp', { commandId: 'command-denied', expectedRevision: 1, value })).rejects.toThrow('foreign installation')
    expect(update).toHaveBeenCalledTimes(1)
  })
  it('publishes selected Operator defaults into the existing immutable record and inspection readback', async () => {
    const defaults = { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harnessProfileSelection: selection } }
    let inserted: unknown
    const pool = { query: vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.includes('insert into operator_configuration_versions')) inserted = JSON.parse(String(args![3]))
      return { rows: sql.startsWith('select record, revision, current_version_id from application_settings') ? [{ record: defaults, revision: '1', current_version_id: 'defaults-v1' }] : [] }
    }) } as unknown as pg.Pool
    const repository = new PostgresOperatorRepository(pool)
    const created = await repository.ensureWithClient(pool as unknown as pg.ClientBase)
    expect(created.configuration.harnessProfileSelection).toEqual(selection)
    expect(inserted).toMatchObject({ harnessProfileSelection: selection })
    const inspection = await repository.inspectionConfiguration()
    expect(inspection.harnessProfileSelection).toEqual(selection)
  })
  it('keeps accepted Operator metadata in per-message immutable settings and exact retries', async () => {
    const base: OperatorConfigurationVersion = { id: 'v1', operatorId: 'operator', version: 1, harness: configuration,
      harnessProfileSelection: selection, contentHash: 'sha256:original', createdAt: '2026-10-01T00:00:00Z' }
    let record: unknown
    const query = { query: vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.includes('insert into operator_configuration_versions')) record = JSON.parse(String(args![3]))
      return { rows: sql.includes('max(version)') ? [{ version: 2 }] : [{ record: base }] }
    }) } as unknown as pg.PoolClient
    await expect(acceptOperatorConfiguration(query, base, {} as never, undefined, { ...configuration, model: 'new-model' })).rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
    const accepted = await acceptOperatorConfiguration(query, base, { settings: { harness: 'codex', model: configuration.model, reasoningEffort: configuration.reasoningEffort, serviceTier: configuration.serviceTier, showThinking: true } } as never, undefined)
    expect(accepted.harnessProfileSelection).toEqual(selection)
    expect(record).toMatchObject({ harnessProfileSelection: selection })
    expect(accepted.contentHash).not.toBe(base.contentHash)
    const retry = await acceptOperatorConfiguration(query, base, {} as never, { operator_configuration_version_id: 'v1' })
    expect(retry.harnessProfileSelection).toEqual(selection)
  })
})
