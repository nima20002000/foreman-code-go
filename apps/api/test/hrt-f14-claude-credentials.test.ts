import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorConfigurationVersionSchema, withAdvancedDefaults, type HarnessQualification } from '@foreman-code/contracts'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { buildProductionApp } from '../src/production.js'
import type { NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import type { AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import type { NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { NativeHarnessConfigurationQualifier } from '../src/modules/harnesses/nativeConfigurationQualifier.js'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'
import { ProductionHostHarnessProfileQualifier } from '../src/modules/harnesses/productionProfileQualifier.js'
import type { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { input } from './fixtures/codex-test-helpers.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'

vi.mock('../src/app.js', async original => {
  const actual = await original<typeof import('../src/app.js')>()
  return { ...actual, buildApp: vi.fn(actual.buildApp) }
})

const harness = { harness: 'claude' as const, model: 'recorded-model', authMode: 'api-key' as const,
  configDirectory: '/recorded/profile', permissionMode: 'default' as const, sandbox: 'read-only' as const,
  tools: [], permissionRules: [], instructions: '', mcpServers: {} }
const blocked = { code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE', status: 409 }
const qualified: HarnessQualification = { harness: 'claude', version: 'recorded', authenticated: true, ready: true,
  structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
  supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('HRT-F14 production without an authorized Claude credential source', () => {
  it.each(['workflow', 'operator', 'agent-chat'] as const)('refuses %s API-key allocation before admitted SDK setup despite ambient authentication', async role => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-inherited-key')
    const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/hrt_f14', CODEX_BINARY: '/nonexistent-recorded-codex' })
    const database = createDatabase(config.database)
    const checkpoints = createCheckpointStore(config.database.connectionString, 'hrt_f14', config.database)
    const allocate = vi.spyOn(NativeHarnessFactories.prototype, 'allocateAdmittedClaude')
    const production = buildProductionApp(config, database, checkpoints, false)
    try {
      const services = vi.mocked(buildApp).mock.calls.at(-1)![0]!.operator!.services
      const agent = { ...input('/recorded/work').request.configuration, harness }
      const operator = OperatorConfigurationVersionSchema.parse({ id: 'configuration-1', operatorId: 'operator', version: 1,
        harness, contentHash: `sha256:${'0'.repeat(64)}`, createdAt: '2026-10-01T00:00:00.000Z' })
      const resolve = () => {
        if (role === 'workflow') {
          const approvals = Reflect.get(production.engine, 'nativeExecutions') as object
          const managers = Reflect.get(approvals, 'managers') as NativeSessionManagerResolver
          return managers.resolve({ executionId: 'execution', agentId: agent.agentId, harness: 'claude',
            workingDirectory: '/recorded/work', configuration: agent, runId: 'run', attempt: 1 })
        }
        if (role === 'operator') return (Reflect.get(services.operatorChat!, 'managers') as NativeManagerResolver)(operator, 'conversation')
        return (Reflect.get(services.agentChat!, 'managers') as AgentChatManagerFactory)('conversation', agent, '/recorded/work')
      }
      expect(resolve).toThrowError(expect.objectContaining(blocked))
      expect(allocate).not.toHaveBeenCalled()
    } finally {
      await production.app.close()
      await Promise.all([database.close(), checkpoints.close()])
    }
  })

  it('refuses launch-ready defaults qualification before querying a native factory', async () => {
    const qualifyConfiguration = vi.fn(async () => qualified)
    const qualifier = new NativeHarnessConfigurationQualifier('/unused', '/unused', { qualifyConfiguration } as unknown as NativeHarnessFactories)
    await expect(Promise.resolve().then(() => qualifier.qualify(harness, '/recorded/work'))).rejects.toMatchObject(blocked)
    expect(qualifyConfiguration).not.toHaveBeenCalled()
  })

  it('refuses the configuration metadata readiness port before consuming qualified profile evidence', async () => {
    const qualify = vi.fn(async () => qualified)
    const service = new NativeConfigurationService('/unused', '/unused', '/recorded/work', undefined, { qualify, discover: vi.fn() })
    await expect(service.qualifyConfiguration(harness)).rejects.toMatchObject(blocked)
    expect(qualify).not.toHaveBeenCalled()
    await service.shutdownChecks()
  })

  it('keeps subscription qualification on the existing native and selected-profile ports', async () => {
    const subscription = { ...harness, authMode: 'subscription' as const }
    const qualifyConfiguration = vi.fn(async () => qualified), qualify = vi.fn(async () => qualified)
    const qualifier = new NativeHarnessConfigurationQualifier('/unused', '/unused', { qualifyConfiguration } as unknown as NativeHarnessFactories)
    const service = new NativeConfigurationService('/unused', '/unused', '/recorded/work', undefined, { qualify, discover: vi.fn() })
    expect(await qualifier.qualify(subscription, '/recorded/work')).toEqual(qualified)
    expect(await service.qualifyConfiguration(subscription)).toEqual(qualified)
    expect(qualifyConfiguration).toHaveBeenCalledOnce(); expect(qualify).toHaveBeenCalledOnce()
    await service.shutdownChecks()
  })

  it.each(['main', 'device'] as const)('refuses %s host-profile qualification before discovery or remote dispatch', async host => {
    const refreshMain = vi.fn(async () => { throw new Error('Unexpected native inventory') })
    const endpoint = vi.fn(() => { throw new Error('Unexpected remote dispatch') })
    const qualifier = new ProductionHostHarnessProfileQualifier({ refreshMain } as unknown as ProductionHarnessRegistry,
      {} as NativeHarnessFactories, endpoint, '/recorded/work', undefined,
      new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
    const mainId = '00000000-0000-4000-8000-000000000001'
    const override: HostHarnessOverride = { instanceId: 'recorded-profile', instanceRevision: '1', revision: 1,
      target: { hostRef: host === 'main' ? { kind: 'main', mainId } : { kind: 'device', mainId, deviceId: '00000000-0000-4000-8000-000000000002' },
        applicationInstallationId: mainId, harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload' },
      presetId: 'recorded', enabled: true, driverId: 'claude', configuration: harness, configurationFingerprint: commandInputHash(withAdvancedDefaults(harness)), qualification: 'qualified' }
    await expect(qualifier.qualify(override, { checkId: '00000000-0000-4000-8000-000000000003', signal: new AbortController().signal })).rejects.toMatchObject(blocked)
    expect(refreshMain).not.toHaveBeenCalled(); expect(endpoint).not.toHaveBeenCalled()
  })
})
