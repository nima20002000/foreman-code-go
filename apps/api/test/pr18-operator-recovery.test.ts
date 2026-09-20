import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'

function fixture() {
  const principal = { id: 'owner', audience: 'operator', revokedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond'], scope: {} }] }
  const configuration = { id: 'configuration', operatorId: 'application-operator', harness: DEFAULT_HARNESS_DEFAULTS.codex }
  const option = { optionId: 'reject', label: 'Reject', semantic: 'reject', scope: 'once' }
  const row = { id: 'chat', owner_principal_id: principal.id, operator_configuration_version_id: configuration.id,
    harness: 'codex', provider_version: 'test', native_session_id: 'session', active_request_id: 'request',
    active_native_turn_id: 'turn', active_phase: 'submitted', cancel_requested: false, revision: 1,
    pending_interaction: { turn: { nativeRequestId: 'approval' }, responseOptions: [option] } }
  const repository = { active: vi.fn(async () => row), configuration: vi.fn(async () => configuration),
    claimResponse: vi.fn(async () => true), pending: vi.fn(async () => {}), submitted: vi.fn(async () => true),
    finish: vi.fn(async () => true), uncertain: vi.fn(async () => {}), unfinished: vi.fn(async () => [row]),
    activity: { append: vi.fn() }, get: vi.fn(async () => ({})) }
  const manager = { harness: 'codex', attachSession: vi.fn(async (session: { nativeSessionId: string }) => session), createSession: vi.fn(), startTurn: vi.fn(),
    respond: vi.fn(async () => {}), stopAutomaticResponses: vi.fn(), dispose: vi.fn(async () => {}),
    reconcile: vi.fn(async () => ({ correlationId: nativeCorrelation('chat', 'request'), nativeTurnId: 'turn', events: [],
      pendingInteractions: [], nativeMessageId: 'answer', terminalResult: { outcome: 'succeeded', output: { text: 'completed before removal' } } })) }
  const authority = { current: vi.fn(async () => principal), assertConfiguration: vi.fn(),
    setup: vi.fn(async () => { throw new Error('native configuration removed or inspection unavailable') }),
    prepare: vi.fn(async () => { throw new Error('new launch must be blocked') }), release: vi.fn(async () => {}) }
  const chat = new OperatorChatService(repository as never, {} as never, (() => manager) as never, '/tmp/pr18-operator', authority as never)
  vi.spyOn(chat, 'get').mockResolvedValue({} as never)
  return { chat, repository, manager, authority, principal, option }
}
it('delivers an owner rejection after MCP removal without setup or issuing new credentials', async () => {
  const f = fixture()
  await f.chat.respond('chat', { requestId: 'request', nativeRequestId: 'approval', optionId: 'reject' }, f.principal as never)
  expect(f.manager.respond).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'session' }), 'approval', f.option, expect.anything())
  expect(f.authority.setup).not.toHaveBeenCalled(); expect(f.authority.prepare).not.toHaveBeenCalled()
  expect(f.manager.createSession).not.toHaveBeenCalled(); expect(f.manager.startTurn).not.toHaveBeenCalled()
  expect(f.repository.finish).toHaveBeenCalledWith('chat', 'request', expect.objectContaining({ outcome: 'succeeded' }), 'answer', false)
})
it('records a detached terminal result after MCP removal without launching or checking installation', async () => {
  const f = fixture()
  await f.chat.reconcileActive()
  expect(f.repository.finish).toHaveBeenCalledWith('chat', 'request', expect.objectContaining({ outcome: 'succeeded' }), 'answer', false)
  expect(f.repository.uncertain).not.toHaveBeenCalled()
  expect(f.authority.setup).not.toHaveBeenCalled(); expect(f.authority.prepare).not.toHaveBeenCalled()
  expect(f.manager.createSession).not.toHaveBeenCalled(); expect(f.manager.startTurn).not.toHaveBeenCalled()
})
