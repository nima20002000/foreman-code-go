import { expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { WorkerConversationHostPorts, WorkerConversationAllocation } from './workerHost.js'
import { createInstalledWorkerConversations } from './installedWorkerConversations.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

vi.mock('../runs/remote/installedWorkflowConfiguration.js', () => ({
  readInstalledWorkflowConfiguration: async () => ({ appMcpLauncher: '/fixture/mcp-launcher' }),
}))
vi.mock('./installedConversationDirectory.js', () => ({
  installedConversationDirectory: async () => ({ assertCurrent: async () => {} }),
}))
vi.mock('./installedNativeProfile.js', () => ({
  createInstalledConversationNativeReader: () => ({ repository: {}, capture: async () => ({
    inspection: { installation: { launcher: { resolvedLauncher: '/fixture/codex' } } },
    qualification: { version: 'fixture-codex' },
  }) }),
}))
vi.mock('./installedClaudeConversationProfile.js', () => ({
  createInstalledClaudeConversationProfile: () => ({ capture: async () => ({
    installation: { launcher: { resolvedLauncher: '/fixture/claude' } }, sdk: { entrypoint: '/fixture/sdk' },
    accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: 'revision' } } },
  }) }),
}))
vi.mock('../harnesses/claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: unknown) => ({ configuration, mcpServers: {}, env: {},
    qualification: { basicTurns: true, resume: true, fork: true, history: true,
      policy: { alwaysAppliedToolHook: true } } }),
}))
vi.mock('./workerHost.js', () => ({
  WorkerConversationHost: class {
    private readonly allocations: WorkerConversationAllocation[] = []
    constructor(private readonly ports: WorkerConversationHostPorts) {}
    async handle(request: Extract<WorkerConversationRpcRequest, {
      method: 'conversation.capabilities' | 'conversation.inspect-mcp'
    }>, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
      const allocation = await this.ports.prepare!(request.binding, request.configuration, connection, signal)
      this.allocations.push(allocation)
      return allocation.start({ correlationId: 'first-message', instructionsDelivered: false })
    }
    async shutdown() {
      await Promise.all(this.allocations.map(allocation => allocation.close()))
    }
  },
}))

it.each([
  ['codex', 'agent'], ['claude', 'agent'], ['codex', 'operator'], ['claude', 'operator'],
] as const)('builds the installed %s %s native startup with its accepted prompt policy', async (harness, role) => {
  const f = workerConversationFixture(role, harness)
  const systemPrompt = { value: { text: 'Accepted app instructions' }, revision: 3, versionId: 'prompt-version-3' }
  const binding = role === 'agent' ? { ...f.binding, systemPrompt } : f.binding
  const registry = {
    scope: (owner: string) => ({ owner }), reserveLaunch: () => ({ launchId: 'fixture-launch' }),
    abandonReservedLaunch: async () => {}, closeOwner: async () => true,
  } as unknown as NativeProcessRegistry
  const journal = { conversations: { claudeCallbackJournal: () => undefined } } as unknown as RemoteOperationJournal
  const host = await createInstalledWorkerConversations({
    stateDirectory: '/fixture/state', configuration: null, registry, journal: async () => journal,
    current: () => f.connection, capture: () => undefined,
    request: async () => { throw new Error('Startup composition must not send a remote request') },
    approvedRoots: async () => { throw new Error('Directory admission is supplied by this fixture') },
    codexSuiteRevision: 'fixture-suite', signal: new AbortController().signal,
  })
  expect(host).not.toBeNull()
  try {
    const startup = await host!.handle({ method: 'conversation.capabilities', binding, configuration: f.configuration },
      f.connection, new AbortController().signal)
    expect(startup).toMatchObject({ kind: role === 'agent' ? 'agent-chat' : 'operator',
      configuration: f.configuration, workingDirectory: binding.workingDirectory })
    if (role === 'agent') expect(startup).toHaveProperty('systemPrompt', systemPrompt)
    else expect(startup).not.toHaveProperty('systemPrompt')
  } finally {
    await host!.close()
  }
})
