import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { WorkerConversationRpcRequestSchema, type WorkerConversationReceipt,
  type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import { createProductionWorkerConversations } from './workerProduction.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerOperatorDirectory } from './workerOperatorDirectory.js'
import { nativeCorrelation } from './operatorChatRepository.js'
import { workerExecutionConfiguration } from './workerExecutionConfiguration.js'
import { legacyProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'

it('admits a thinking-only next turn through the production Worker channel without replacing saved execution ownership', async () => {
  const f = workerConversationFixture()
  if (!('operatorId' in f.configuration) || f.binding.owner.kind !== 'operator') throw new Error('Operator fixture required')
  const accepted = OperatorConfigurationVersionSchema.parse({ ...f.configuration, id: randomUUID(), version: 2,
    contentHash: `sha256:${'b'.repeat(64)}`, showThinking: true })
  const root = '/approved/runtime'
  const binding = { ...f.binding, workingDirectory: workerOperatorDirectory(root, f.binding.owner),
    accountBinding: legacyProviderAccountBinding(f.configuration.harness, f.configuration.harnessProfileSelection)! }
  const first = { correlationId: 'first-turn',
    inputHash: commandInputHash({ prompt: 'First turn', mode: 'regular', preferences: null }),
    status: 'completed' as const,
    nativeTurnId: 'first-native-turn', result: { outcome: 'succeeded' as const } }
  const firstSnapshot = structuredClone(first)
  const receipt: WorkerConversationReceipt = { binding, connection: f.connection, session: f.session,
    nativeOwner: f.nativeOwner, revision: 1, closed: false, closing: false, turns: [first],
    compactions: [], desiredPreferences: null, appliedPreferences: null }
  const owner = { id: 'human', name: 'Human', audience: 'operator', delegated_from: null,
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
    expires_at: new Date(Date.now() + 600_000), revoked_at: null }
  const conversation = { id: binding.owner.conversationId, kind: 'operator', owner_principal_id: owner.id,
    operator_configuration_version_id: accepted.id, active_request_id: 'next-turn',
    native_session_id: f.session.nativeSessionId, deleted_at: null, record: { status: 'open' },
    payload: { ownerPrincipalId: owner.id }, worker_conversation_binding: binding }
  const pool = { query: vi.fn(async (sql: string) => {
    if (sql.includes('from management_principals')) return { rows: [owner] }
    if (sql.includes('from provider_account_accepted_bindings')) return { rows: [{ binding: binding.accountBinding }] }
    return { rows: [conversation], rowCount: 1 }
  }) } as unknown as pg.Pool
  const frames: WorkerConversationRpcRequest[] = []
  const channel = { binding: f.connection, request: async (raw: unknown) => {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    frames.push(request)
    if (request.method === 'conversation.start-turn') {
      receipt.turns.push({ correlationId: request.correlationId,
        inputHash: commandInputHash({ prompt: request.prompt, mode: request.sessionMode ?? 'regular',
          preferences: request.preferences ?? null }),
        status: 'completed', nativeTurnId: 'next-native-turn', result: { outcome: 'succeeded' } })
      receipt.revision++
    }
    if (request.method === 'conversation.history') return { payload: { receipt, context: null,
      history: { events: [], pendingInteractions: [], nextSequence: 0 } } }
    return { payload: { receipt } }
  } }
  const filesystem = { device: '1', inode: '1', mountId: '1' }
  const roots = { binding: f.connection, request: async () => ({ payload: {
    schemaVersion: 1, hostRef: binding.profile.target.hostRef,
    applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: '/approved', filesystem, accessModes: ['read-write'] }],
    managedRuntimeRoot: root, runtimeFilesystem: filesystem,
  } }) }
  const profiles = { admit: vi.fn(async () => ({ override: {
    configuration: f.configuration.harness, target: binding.profile.target,
  } })), revalidate: vi.fn(async () => {}) }
  const production = createProductionWorkerConversations({ pool,
    endpoint: () => ({ captureRequest: (_device: string, namespace: string) =>
      namespace === WORKSPACE_ROOT_EXTENSION.namespace ? roots : channel }),
    profiles, claudeProfiles: profiles,
    operators: { configuration: async () => f.configuration }, agents: {}, registry: {}, qualifications: {},
    suiteRevisions: {}, access: {}, mcpForward: () => ({}),
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const manager = production.create({ conversationId: conversation.id, configuration: accepted,
    workingDirectory: '/main/runtime', appMcpAccess: 'none' })
  try {
    await expect(manager.attachSession(f.session, { kind: 'operator', configuration: accepted,
      correlationId: nativeCorrelation(conversation.id, 'next-turn'), workingDirectory: '/main/runtime' }))
      .resolves.toEqual(f.session)
    const events = []
    for await (const event of manager.startTurn(f.session, { prompt: 'Continue',
      clientCorrelationId: nativeCorrelation(conversation.id, 'next-turn') })) events.push(event)
    expect(events).toEqual([])
    expect(frames.filter(frame => frame.method === 'conversation.start-turn')).toHaveLength(1)
    expect(frames.find(frame => frame.method === 'conversation.open')).toMatchObject({
      mode: 'attach', binding, configuration: f.configuration,
    })
    expect(receipt.turns[0]).toEqual(firstSnapshot)
    expect(conversation.worker_conversation_binding).toEqual(binding)
    expect(commandInputHash(f.configuration)).toBe(binding.owner.configurationHash)
    owner.grants = [{ actions: ['operator_chat:read'], scope: {} }]
    await expect(manager.attachSession(f.session, { kind: 'operator', configuration: accepted,
      correlationId: 'denied', workingDirectory: '/main/runtime' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  } finally { await manager.dispose?.(); await production.close() }
})

it('rejects execution, profile, owner and bound-hash changes during a presentation transition', () => {
  const f = workerConversationFixture()
  const configuration = f.configuration
  if (!('operatorId' in configuration)) throw new Error('Operator fixture required')
  const accepted = { ...configuration, id: 'presentation', version: 2, showThinking: true }
  expect(workerExecutionConfiguration(f.binding, accepted, configuration)).toEqual(configuration)
  for (const candidate of [
    { ...accepted, harness: { ...accepted.harness, model: 'different' } },
    { ...accepted, operatorId: 'other-owner' },
    { ...accepted, harnessProfileSelection: { ...f.binding.profile, instanceRevision: 'other-profile' } },
  ]) expect(() => workerExecutionConfiguration(f.binding, candidate, configuration)).toThrow()
  expect(() => workerExecutionConfiguration({ ...f.binding, owner: { ...f.binding.owner,
    configurationHash: '0'.repeat(64) } }, accepted, configuration)).toThrow()
})
