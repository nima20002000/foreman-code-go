import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, OperatorConfigurationVersionSchema } from '@graphql/contracts'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { CLAUDE_QUALIFICATION_CHECKS } from '@graphql/contracts/claude-qualification'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import { AcceptedClaudeProfileAdmission } from '../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import type { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { productionClaudeManager } from '../src/modules/harnesses/claudeSdk/production.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeDomainBinding } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const createdAt = '2026-10-01T00:00:00.000Z'
/** Synthetic installed/profile records and redacted SDK frames. Exercises actual
 * admission/domain/factory/manager classes without native or PostgreSQL claims. */
function fixture(surface: 'workflow' | 'operator' | 'agent' | 'selected-run', sharedFactories?: NativeHarnessFactories) {
  const kind = surface === 'selected-run' ? 'agent' : surface
  const target = { hostRef: { kind: 'main' as const, mainId: '77d29f00-408e-4000-8000-000000000001' },
    applicationInstallationId: '77d29f00-408e-4000-8000-000000000001', harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload' }
  const harness = { harness: 'claude' as const, model: 'recorded-model', authMode: 'subscription' as const,
    configDirectory: '/recorded/profile', permissionMode: 'default' as const, sandbox: 'read-only' as const,
    tools: [], permissionRules: [], instructions: 'Pinned fixture instructions', mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3000/mcp' } } }
  const override: HostHarnessOverride = { instanceId: 'recorded-profile', instanceRevision: 'profile-1', revision: 1,
    target, presetId: 'recorded', enabled: true, driverId: 'claude', configuration: harness, configurationFingerprint: 'recorded-config', qualification: 'qualified' }
  const pin = { sdkVersion: '0.3.284', sdkIntegrity: 'recorded-integrity', cliVersion: '2.1.284', executableSha256: 'a'.repeat(64),
    profilePath: harness.configDirectory, configRevision: 'profile-1' }
  const proof: HostHarnessProfileEvidence = { target, instanceRevision: override.instanceRevision, configurationFingerprint: override.configurationFingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: 'recorded-protocol', suiteRevision: 'recorded-suite', environmentGeneration: 'recorded-env',
    connectionGeneration: 'recorded-connection', authenticated: true, compatible: true, qualified: true, checkedAt: createdAt,
    claudeProof: { pin, checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map(check => [check, { state: 'passed' as const,
      source: 'native_scenario' as const, evidenceId: `synthetic:${check}`, evidenceSha256: 'b'.repeat(64) }])) } }
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload([{ instanceId: override.instanceId, instanceRevision: override.instanceRevision, driverId: 'claude', enabled: true, configuration: harness }])
  const installations = new HarnessInstallationRegistry(instances)
  const launcher = { requested: '/recorded/claude', resolvedLauncher: '/recorded/claude', fingerprint: target.installationFingerprint,
    status: 'installed' as const, interpreter: null, diagnostics: [], environment: { generation: 'recorded-env', provenance: 'terminal' as const, cwd: '/recorded', path: '/recorded' }, checkedAt: createdAt }
  installations.refresh([{ hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId, installationFingerprint: target.installationFingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: proof.protocolRevision, environmentGeneration: proof.environmentGeneration,
    connectionGeneration: proof.connectionGeneration, launcher, observedVersion: pin.cliVersion, installed: true, authenticated: null, compatible: null, qualified: null }])
  const binding = installations.pin({ instanceId: override.instanceId, hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    environmentGeneration: proof.environmentGeneration, connectionGeneration: proof.connectionGeneration })
  const client = {} as pg.PoolClient
  const profiles = new AcceptedClaudeProfileAdmission<ClaudeDomainBinding>(
    { readAuthorized: async <T>(read: (sql: pg.PoolClient) => Promise<T>) => read(client), latest: async () => override, lockRevision: async () => {} } as unknown as HarnessInstanceSettingsRepository,
    { latest: async () => proof } as unknown as HostHarnessProfileEvidenceRepository,
    { authorize: async () => {}, current: async () => ({ registry: binding, applicationInstallationId: target.applicationInstallationId, suiteRevision: proof.suiteRevision, pin }), assertCurrent: value => installations.assertCurrent(value) })
  const agent = AgentConfigurationVersionSchema.parse({ id: 'configuration-1', workspaceId: 'workspace', agentId: 'agent', productRole: 'coder', version: 1,
    harness, prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  const operator = OperatorConfigurationVersionSchema.parse({ id: 'configuration-1', operatorId: 'operator', version: 1, harness, contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  const version = WorkflowVersionV3Schema.parse({ id: 'version', workspaceId: 'workspace', workflowId: 'workflow', version: 1, executionSemanticsVersion: 3,
    entryNodeId: 'node', approval: { handler: 'user' }, agentConfigurationVersionIds: { agent: agent.id }, contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
    definition: { id: 'workflow', workspaceId: 'workspace', name: 'Synthetic replay', version: 1, executionSemanticsVersion: 3, entryNodeId: 'node', approval: { handler: 'user' },
      executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 }, nodes: [{ id: 'node', agentId: 'agent', name: 'Agent' }], edges: [] } })
  const run = WorkflowRunV3Schema.parse({ id: 'run', workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: version.id, executionSemanticsVersion: 3,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval: version.approval, executionCondition: { kind: 'manual' }, executionState: 'running', outcome: 'pending', input: {}, createdAt })
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent', agentConfigurationVersionId: agent.id, attempt: 1, state: 'starting', input: {}, createdAt })
  const row = { kind, owner_principal_id: 'sender', workspace_id: 'workspace', workflow_id: 'workflow', origin_run_id: surface === 'selected-run' ? 'selected-run' : null,
    active_request_id: 'request-1', native_session_id: null, provider_version: null, cancel_requested: false, deleted_at: null, record: { status: 'open' }, payload: { ownerPrincipalId: 'sender' } }
  const query = vi.fn(async (sql: string) => {
    const rows = sql.includes('e.record as execution') ? [{ run, version, execution, configuration: agent, attempt: 1, stopped: false,
      execution_closed: false, native_reference: null, finalized: false, generation: null, native_owner: null, budget_active: true }]
      : sql.includes("record->>'authorizationPrincipalId'") ? [{ principal_id: 'sender' }]
        : sql.includes('from management_principals where id=') ? [{ id: 'sender', name: 'Recorded sender', audience: 'operator', grants: [{ actions: ['runs:start', 'operator_chat:read', 'operator_chat:write', 'agent_chat:read', 'agent_chat:write'], scope: {} }], expires_at: new Date('2099-01-01'), revoked_at: null, delegated_from: null }]
          : sql.includes('join operator_conversation_turns t') ? [row] : undefined
    if (!rows) throw new Error('Unexpected SQL in fixture: ' + sql.slice(0, 80))
    return { rows }
  })
  const pool = { query } as unknown as pg.Pool
  const owner = { runId: 'run', client: pool, assertOwned: () => {}, readOneShotFence: async () => ({ ownerId: 'recorded-owner', fence: 'recorded-fence' }) } as unknown as RunOwnership
  const domain: ClaudeDomainBinding = kind === 'workflow' ? { kind, runId: 'run', executionId: 'execution', attempt: 1, getOwner: () => owner }
    : kind === 'operator' ? { kind, conversationId: surface, repository: new PostgresOperatorConversationRepository(pool) }
      : { kind: 'agent', conversationId: surface, workspaceId: 'workspace', repository: new PostgresAgentChatRepository(pool) }
  const start: NativeSessionStart = kind === 'operator' ? { kind: 'operator', correlationId: `${surface}:request-1`, configuration: operator, workingDirectory: '/recorded/work' }
    : { kind: 'workflow', correlationId: `${surface}:request-1`, request: { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/recorded/work', runtimeDirectory: '/recorded/runtime', configuration: agent, input: {} } }
  const frames = new ClaudeBoundedQueue<unknown>(64), ready = deferred<AsyncIterator<ClaudeSdkUserMessage>>()
  const setMcpServers = vi.fn(async () => ({ added: ['graphql'], removed: [], errors: {} }))
  const sdkQuery = vi.fn<ClaudeSdkClient['query']>(options => {
    ready.resolve(options.prompt[Symbol.asyncIterator]())
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(), interrupt: async () => undefined,
      initializationResult: async () => ({}), setMcpServers,
      mcpServerStatus: async () => [{ name: 'graphql', status: 'connected', config: { type: 'http', url: harness.mcpServers.graphql.url }, tools: [] }] }
  })
  const sdk: ClaudeSdkClient = { sdkVersion: pin.sdkVersion, query: sdkQuery, getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'recorded-fork' }) }
  const loadClient = vi.fn(async () => sdk)
  const factories = sharedFactories ?? new NativeHarnessFactories({ codexBinary: '/forbidden-codex', openCodeBinary: '/forbidden-opencode', instances, installations,
    installationDiscovery: async () => launcher })
  const result = productionClaudeManager({ pool, factories, registry: { pinOverride: () => binding } as unknown as ProductionHarnessRegistry,
    profiles, selector: { instanceId: override.instanceId, instanceRevision: override.instanceRevision, target }, binding: domain,
    role: kind === 'agent' ? 'agent-chat' : kind, configuration: harness, workingDirectory: '/recorded/work', ownerAgentId: surface,
    recovery: { root: '/forbidden-native-recovery', owner: surface }, appMcpAccess: kind === 'agent' ? 'none' : 'scoped', mode: 'replay',
    inspectionStart: async () => start, loadClient })
  return { ...result, start, profiles, proof, ready, frames, sdkQuery, loadClient, query, factories, setMcpServers, harness, binding, installations, launcher }
}

async function replay(f: ReturnType<typeof fixture>) {
  const observed: string[] = []
  const output = (async () => {
    for await (const event of f.manager.startInitialTurn(f.start, { prompt: 'Recorded input', clientCorrelationId: f.start.correlationId!,
      onSessionObserved: async session => { observed.push(`session:${session.nativeSessionId}`) },
      onMessageSubmitted: async receipt => { expect(observed).toEqual(['session:recorded-session']); observed.push(`message:${receipt.nativeMessageId}`) },
    })) observed.push(event.type)
  })()
  const message = (await (await f.ready.promise).next()).value!
  f.frames.offer({ type: 'system', subtype: 'init', session_id: 'recorded-session', claude_code_version: '2.1.284', cwd: '/recorded/work' })
  f.frames.offer({ type: 'assistant', uuid: 'recorded-reply', session_id: 'recorded-session', user_message_uuid: message.uuid,
    parent_tool_use_id: null, message: { id: 'recorded-api-message', content: [{ type: 'text', text: 'Recorded reply' }] } })
  f.frames.offer({ type: 'result', uuid: 'recorded-result', session_id: 'recorded-session', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'Recorded reply' })
  await output
  return observed
}

describe('common admitted production Claude four-surface replay', () => {
  it.each(['workflow', 'operator', 'agent', 'selected-run'] as const)('loads exact profile and existing %s domain before observed native message', async surface => {
    const f = fixture(surface)
    expect(f.loadClient).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
    expect((await replay(f)).some(value => value === 'claude.text')).toBe(true)
    expect(f.sdkQuery).toHaveBeenCalledOnce()
    expect(f.loadClient).toHaveBeenCalledWith({ profilePath: '/recorded/profile', recovery: { root: '/forbidden-native-recovery', owner: surface }, binary: '/recorded/claude' })
    const options = f.sdkQuery.mock.calls[0]![0].options
    expect(options.canUseTool).toBeTypeOf('function'); expect(options.settingSources).toEqual([])
    expect(options.env).not.toHaveProperty('GRAPHQL_MCP_TOKEN')
    if (surface === 'agent' || surface === 'selected-run') expect(options.mcpServers).not.toHaveProperty('graphql')
    await f.manager.dispose?.()
  })
  it('shares one configured factory while all four domain owners retain separate SDK queries', async () => {
    const workflow = fixture('workflow')
    const owners = [workflow, fixture('operator', workflow.factories), fixture('agent', workflow.factories), fixture('selected-run', workflow.factories)]
    expect(workflow.factories.instances.list()).toHaveLength(1)
    expect(new Set(owners.map(owner => owner.manager)).size).toBe(4)
    const outputs = await Promise.all(owners.map(replay))
    expect(outputs.every(events => events.includes('claude.text'))).toBe(true)
    await workflow.manager.dispose?.()
    expect(owners.slice(1).every(owner => owner.loadClient.mock.calls.length === 1)).toBe(true)
    for (const owner of owners.slice(1)) expect(await owner.manager.capabilities()).toMatchObject({ provider: 'claude', persistentSessions: true })
    await Promise.all(owners.slice(1).map(owner => owner.manager.dispose?.()))
  })
  it('rejects a workflow credential copied into Agent chat before opening the SDK query', async () => {
    const f = fixture('agent')
    const iterator = f.manager.startInitialTurn({ ...f.start, environment: { agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: 'copied-token' } } }, {
      prompt: 'Recorded input', clientCorrelationId: 'agent:request-1', onSessionObserved: async () => {},
    })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('cannot inherit')
    expect(f.loadClient).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })
  it('requires the actual retained-query HTTP ACK before common credential detection is connected', async () => {
    const f = fixture('operator')
    const detection = new McpDetectionService(f.factories.inspector(f.manager), f.harness.mcpServers.graphql.url)
    const context = { harness: 'claude' as const, runnerId: 'runner-local', workingDirectory: '/recorded/work' }
    expect((await detection.inspect(context)).detection.credentialArrangement).toEqual({ kind: 'unknown' })
    const start = { ...f.start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'synthetic-scoped-token' } } }
    const servers = { graphql: { type: 'http', url: f.harness.mcpServers.graphql.url, headers: { Authorization: 'Bearer synthetic-scoped-token' } } }
    await f.manager.refreshInspectionCredentials(start, servers)
    const evidence = await f.factories.inspector(f.manager).inspect({ ...context, serverName: 'graphql' })
    expect(evidence.entry?.credentialArrangement).toMatchObject({ kind: 'scoped_http_header', acknowledgement: {
      source: 'sdk_set_mcp_servers', generation: evidence.generation, authorizationScope: evidence.authorizationScope,
    } })
    expect((await detection.preflight(context)).detection).toMatchObject({ state: 'connected', credentialEnvironmentVariable: null,
      credentialArrangement: { kind: 'scoped_http_header' } })
    expect(f.setMcpServers).toHaveBeenCalledExactlyOnceWith(servers)
    expect(f.sdkQuery).toHaveBeenCalledOnce()
    expect(JSON.stringify(evidence)).not.toContain('synthetic-scoped-token')
    await f.manager.dispose?.()
  })
  it('rejects a stale exact profile before loading any SDK client', async () => {
    const f = fixture('agent'); f.proof.connectionGeneration = 'changed'
    await expect(f.manager.capabilities()).rejects.toThrow('stale')
    expect(f.loadClient).not.toHaveBeenCalled(); expect(f.sdkQuery).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })
  it('joins disposal during exact profile admission without constructing a native query', async () => {
    const f = fixture('agent'), entered = deferred<void>(), release = deferred<void>()
    const actualAdmission = f.profiles.admit.bind(f.profiles)
    vi.spyOn(f.profiles, 'admit').mockImplementation(async (owner, selector) => {
      entered.resolve(); await release.promise
      return actualAdmission(owner, selector)
    })
    const pending = expect(f.manager.capabilities()).rejects.toThrow('disposed')
    await entered.promise
    const disposal = f.manager.dispose!()
    expect(f.loadClient).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([pending, disposal])
    expect(f.sdkQuery).not.toHaveBeenCalled()
  })
  it('disposes an unopened allocation without looking up a profile or SDK', async () => {
    const f = fixture('operator'), admit = vi.spyOn(f.profiles, 'admit')
    await f.manager.dispose?.()
    expect(admit).not.toHaveBeenCalled(); expect(f.loadClient).not.toHaveBeenCalled()
  })
})


describe('actual common owned Claude version command', () => {
  function ownedVersion() {
    const f = fixture('operator')
    const recovery = { root: '/forbidden-registry', owner: 'diagnostics:recorded', launchId: 'recorded-launch' }
    const command = vi.fn(async () => ({ exitCode: 0, stdout: '2.1.284 (Claude Code)\n', stderr: '' }))
    const close = vi.fn(async () => {})
    const abandon = vi.fn(async () => {})
    const admit = vi.fn()
    const factories = new NativeHarnessFactories({ codexBinary: '/forbidden', openCodeBinary: '/forbidden',
      instances: f.factories.instances, installations: f.installations, installationDiscovery: async () => f.launcher,
      auxiliaryRecovery: () => recovery, admitRecovery: admit, abandonRecovery: abandon, closeRecovery: close, claudeVersionCommand: command })
    return { ...f, factories, recovery, command, close, abandon, admit }
  }
  it('returns version evidence only after positive original-owner cleanup and never supplies auth variables', async () => {
    const f = ownedVersion(), entered = deferred<void>(), release = deferred<void>()
    f.close.mockImplementation(async () => { entered.resolve(); await release.promise })
    let settled = false
    const probe = f.factories.observeClaudeVersion(f.binding, '/recorded-neutral').then(result => { settled = true; return result })
    await entered.promise
    expect(settled).toBe(false)
    const call = f.command.mock.calls[0] as unknown as [string, string[], string, AbortSignal, NodeJS.ProcessEnv, { recovery: unknown; maxOutputBytes: number }]
    expect(call.slice(0, 3)).toEqual(['/recorded/claude', ['--version'], '/recorded-neutral'])
    expect(call[4]).not.toHaveProperty('GRAPHQL_MCP_TOKEN'); expect(call[4]).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(call[5]).toEqual({ recovery: f.recovery, maxOutputBytes: 16_384 })
    release.resolve()
    expect(await probe).toMatchObject({ version: '2.1.284', positiveProcessClosure: true,
      installationFingerprint: f.binding.selection.installationFingerprint })
    expect(f.admit).toHaveBeenCalledExactlyOnceWith(f.recovery)
    expect(f.abandon).toHaveBeenCalledExactlyOnceWith(f.recovery)
    await f.manager.dispose?.()
  })
  it('retains a failed physical close and blocks fresh version inspection until retry succeeds', async () => {
    const f = ownedVersion()
    f.close.mockRejectedValueOnce(new Error('closure pending'))
    await expect(f.factories.observeClaudeVersion(f.binding, '/recorded-neutral')).rejects.toThrow('closure pending')
    await expect(f.factories.observeClaudeVersion(f.binding, '/recorded-neutral')).rejects.toThrow('Retry retained')
    expect(f.command).toHaveBeenCalledOnce()
    await f.factories.disposeAuxiliaries()
    expect(f.close).toHaveBeenCalledTimes(2)
    await f.manager.dispose?.()
  })
  it('aborts and joins an in-flight version command during the existing factory shutdown phase', async () => {
    const f = ownedVersion(), entered = deferred<void>()
    f.command.mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = args[3] as AbortSignal
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }))
    const probe = expect(f.factories.observeClaudeVersion(f.binding, '/recorded-neutral')).rejects.toThrow('shutting down')
    await entered.promise
    f.factories.stopAuxiliaries()
    await Promise.all([probe, f.factories.disposeAuxiliaries()])
    expect(f.close).toHaveBeenCalledOnce()
    await f.manager.dispose?.()
  })
})
