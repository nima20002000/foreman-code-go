import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { MainWorkerConversationMcp } from './mainWorkerMcp.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { AcceptedHarnessProfileAdmission } from '../harnesses/instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from '../harnesses/claudeSdk/production.js'
import { HarnessInstanceSettingsRepository } from '../harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../harnesses/instanceSettings/profileRepository.js'
import { DomainError } from '../errors.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('rejects a revoked credential, a foreign channel and Agent management MCP before forwarding', async () => {
  const f = workerConversationFixture()
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1/unused_test' })
  const authenticate = vi.fn(async () => { throw new DomainError('AUTH_REVOKED', 'Credential revoked', 401) })
  const forward = vi.fn(async () => { throw new Error('Denied MCP reached the endpoint') })
  const profiles = new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(
    new HarnessInstanceSettingsRepository(pool), new HostHarnessProfileEvidenceRepository(pool), {
      authorize: async () => { throw new Error('Denied credential reached profile admission') },
      current: async () => { throw new Error('Denied credential reached native inventory') }, assertCurrent: () => {},
    })
  let current = f.connection
  const relay = new MainWorkerConversationMcp({ pool, access: { authenticate }, profiles, claudeProfiles: profiles,
    operators: new PostgresOperatorConversationRepository(pool), bridge: new MainWorkerConversationBridge(),
    current: () => current, forward: () => ({ request: forward }) })
  const request = { version: 1, operation: 'conversation-mcp.request', token: 'fixture-revoked',
    binding: { ...f.binding, appMcpAccess: 'scoped' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }
  try {
    await expect(relay.handle(request, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    current = { ...current, authorizationRevision: current.authorizationRevision + 1 }
    await expect(relay.handle(request, f.connection, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_MCP_DENIED' })
    const agent = workerConversationFixture('agent')
    await expect(relay.handle({ ...request, binding: agent.binding }, agent.connection, AbortSignal.timeout(1000))).rejects.toThrow()
    expect(authenticate).toHaveBeenCalledOnce()
    expect(forward).not.toHaveBeenCalled()
  } finally { await pool.end() }
})
