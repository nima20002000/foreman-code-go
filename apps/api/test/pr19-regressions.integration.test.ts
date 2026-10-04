import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DEFAULT_HARNESS_DEFAULTS, NativeHarnessEventSchema, operatorChatSettings,
  type HarnessConfiguration, type NativeSessionReference, type SendOperatorMessageRequest } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { OperatorChatService, PostgresOperatorConversationRepository, type OperatorChatAuthority } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority, OPERATOR_MCP_ENVIRONMENT_VARIABLE } from '../src/modules/conversations/operatorChatAuthority.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { nativePolicy } from '../src/modules/harnesses/opencodeProtocol.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { DomainError } from '../src/modules/errors.js'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

/** Provider I/O fixture, not a live-provider acceptance test. Native policy is
 * retained on the session and compared on every attach, never overwritten.
 */
class PolicyRetainingManager implements NativeHarnessSessionManager {
  sessions = 0; turns = 0; attachments = 0
  prompts: string[] = []
  chronology = false
  private readonly policies = new Map<string, string>()
  private readonly histories = new Map<string, NativeHistory>()
  constructor(readonly harness: 'codex' | 'opencode') {}
  capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> { throw new Error('Unused fixture capability endpoint') }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('Unused fixture MCP endpoint') }
  private policy(input: NativeSessionStart): string {
    if (input.kind !== 'operator') throw new Error('Expected an Operator session')
    return JSON.stringify(input.configuration.harness.harness === 'opencode' ? nativePolicy(input.configuration.harness) : input.configuration.harness.sandbox)
  }
  async createSession(input: NativeSessionStart): Promise<NativeSessionReference> {
    const nativeSessionId = `${this.harness}-session-${++this.sessions}`
    this.policies.set(nativeSessionId, this.policy(input))
    return { harness: this.harness, providerVersion: 'policy-retaining-test-fixture', nativeSessionId }
  }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart) {
    this.attachments++
    if (this.policies.get(session.nativeSessionId) !== this.policy(input)) throw new DomainError('OPENCODE_SESSION_PERMISSION_MISMATCH', 'Fixture retained the original native permission policy.', 409)
    return session
  }
  async *startTurn(session: NativeSessionReference, input: NativeTurnInput) {
    this.prompts.push(input.prompt)
    const nativeTurnId = `turn-${++this.turns}`
    const parent = `public-${nativeTurnId}`
    const event = (type: string, payload: Record<string, unknown>, sequence: number) => NativeHarnessEventSchema.parse({
      type, payload, sequence, connectionId: 'fixture', occurredAt: new Date(1000 + sequence).toISOString() })
    const events = this.chronology ? [
      event('message.updated', { info: { id: nativeTurnId, sessionID: session.nativeSessionId, role: 'user' } }, 1),
      event('message.part.updated', { part: { id: `user-${nativeTurnId}`, messageID: nativeTurnId, type: 'text', text: input.prompt, time: { end: 1 } } }, 2),
      event('message.updated', { info: { id: parent, sessionID: session.nativeSessionId, parentID: nativeTurnId, role: 'assistant', time: { completed: 1 } } }, 3),
      event('message.part.updated', { part: { id: `before-${nativeTurnId}`, messageID: parent, type: 'text', text: '' } }, 4),
      event('message.part.updated', { part: { id: `before-${nativeTurnId}`, messageID: parent, type: 'text', text: 'Before the tool.', time: { end: 1 } } }, 5),
      event('message.part.updated', { part: { id: `tool-${nativeTurnId}`, messageID: parent, type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'fixture' }, output: 'ok' } } }, 6),
      event('message.part.updated', { part: { id: `after-${nativeTurnId}`, messageID: parent, type: 'text', text: 'After the tool.', time: { end: 2 } } }, 7),
    ] : []
    this.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId, nativeTurnId,
      nativeMessageId: parent, events, pendingInteractions: [], terminalResult: { outcome: 'succeeded',
        output: { text: this.chronology ? 'Before the tool.After the tool.' : 'Completed.' } } })
    await input.onSubmitted?.(nativeTurnId)
    for (const item of events) yield item
  }
  async pending() { return undefined }
  async respond() {}
  async cancel() { return false }
  async history(): Promise<NativeHistory> { return { events: [], pendingInteractions: [] } }
  async reconcile(_session: NativeSessionReference, correlation: string): Promise<NativeHistory> {
    return this.histories.get(correlation) ?? { events: [], pendingInteractions: [] }
  }
  async close() {}
  async dispose() {}
}

const connectionString = process.env.TEST_DATABASE_URL!
let admin: pg.Pool, pool: pg.Pool, schema: string, owner: ManagementPrincipal
let access: PostgresAccessService, repository: PostgresOperatorConversationRepository, defaults: PostgresFoundationSettingsRepository
let chat: OperatorChatService, authority: OperatorChatAuthority, codex: PolicyRetainingManager, openCode: PolicyRetainingManager
async function idle(id: string) {
  for (let index = 0; index < 200; index++) {
    const state = await chat.get(id, owner)
    if (!state.activeRequestId) return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('The fixture turn did not end')
}
async function setDefaults(harness: HarnessConfiguration) {
  const current = await defaults.getAgentDefaults()
  const saved = await defaults.updateAgentDefaults({ ...current.value, operator: { ...current.value.operator, harness } }, current.revision)
  const operators = new PostgresOperatorRepository(pool)
  await operators.update(harness, (await operators.ensure()).configuration.id)
  return saved
}
beforeEach(async () => {
  schema = `pr19_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  access = new PostgresAccessService(pool)
  owner = (await access.issue({ name: 'PR19 owner', audience: 'operator', grants: [{ actions: [
    'operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'settings:read', 'settings:update',
  ], scope: {} }], expiresAt: new Date(Date.now() + 600000) })).principal
  repository = new PostgresOperatorConversationRepository(pool)
  defaults = new PostgresFoundationSettingsRepository(pool)
  codex = new PolicyRetainingManager('codex'); openCode = new PolicyRetainingManager('opencode')
  authority = { current: (id) => access.currentOperator(id), assertConfiguration() {},
    setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
    prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {} }
  chat = new OperatorChatService(repository, new PostgresOperatorRepository(pool),
    (configuration) => configuration.harness.harness === 'codex' ? codex : openCode, '/tmp/pr19-operator-fixture', authority)
}, 30000)
afterEach(async () => {
  vi.restoreAllMocks()
  await chat?.shutdown(); await pool?.end()
  if (schema) await (admin ? dropFixtureSchema(admin, schema) : Promise.resolve())
  await admin?.end()
})

async function handoff() {
  const source = await chat.create(owner)
  await chat.send(source.id, { requestId: 'source-request', content: 'Remember the release context.' }, owner)
  const state = await idle(source.id)
  const current = await setDefaults(DEFAULT_HARNESS_DEFAULTS.opencode)
  const request = { requestId: 'handoff-request', content: 'Continue.', settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.opencode),
    configurationVersionId: state.conversation.operatorConfigurationVersionId, defaultsRevision: current.revision, forkExpectedRevision: state.revision }
  return { source, request }
}

describe('PR19 durable admission, authentication and native-session regressions', () => {
  it('freezes restrictive execution policy before admission and restores the exact receipt after a later turn', async () => {
    await setDefaults({ ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'read-only' })
    const conversation = await chat.create(owner)
    const configuration = (await repository.configuration(conversation.operatorConfigurationVersionId!))!
    const request: SendOperatorMessageRequest = { requestId: 'first', content: 'Inspect only.',
      settings: operatorChatSettings(configuration.harness), configurationVersionId: configuration.id }
    await setDefaults({ ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'danger-full-access' })
    const harness = await repository.harnessForMessage(configuration, request)
    expect(harness).toEqual(configuration.harness)
    const first = await repository.beginTurn(conversation.id, request, owner.id, harness, configuration.id)
    const acceptedId = first.state.conversation.operatorConfigurationVersionId!
    await repository.finish(conversation.id, request.requestId, { outcome: 'failed', error: { code: 'BEFORE_SUBMIT', message: 'Fixture pre-submission rejection.', retryable: true } }, undefined, true)
    const secondHarness = { ...harness, model: `${harness.model}-later` }
    const second = await repository.beginTurn(conversation.id, { requestId: 'second', content: 'Later controls.', settings: operatorChatSettings(secondHarness) }, owner.id, secondHarness)
    expect(second.state.conversation.operatorConfigurationVersionId).not.toBe(acceptedId)
    await repository.finish(conversation.id, 'second', { outcome: 'canceled' })
    const retried = await repository.beginTurn(conversation.id, request, owner.id)
    expect(retried.state.conversation.operatorConfigurationVersionId).toBe(acceptedId)
    const acceptedConfiguration = (await repository.configuration(acceptedId))!
    expect(retried.state.settings).toEqual(operatorChatSettings(acceptedConfiguration.harness, acceptedConfiguration.showThinking))
    const receipt = await pool.query<{ payload: { acceptedConfigurationVersionId: string } }>('select payload from operator_conversation_turns where conversation_id=$1 and request_id=$2', [conversation.id, request.requestId])
    expect(receipt.rows[0]!.payload.acceptedConfigurationVersionId).toBe(acceptedId)
  })
  it('rejects a changed defaults revision instead of substituting a newer handoff policy', async () => {
    const { source, request } = await handoff()
    await setDefaults({ ...DEFAULT_HARNESS_DEFAULTS.opencode, advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!,
      permissionRules: [{ permission: 'shell', pattern: '*', effect: 'deny' }] } })
    await expect(chat.send(source.id, request, owner)).rejects.toMatchObject({ code: 'CONVERSATION_REVISION_CONFLICT' })
    expect(await repository.active('operator-fork:handoff-request')).toBeUndefined()
    expect(openCode.turns).toBe(0)
  })
  it('continues a persisted OpenCode session on its original native permission policy after access defaults change', async () => {
    await setDefaults(DEFAULT_HARNESS_DEFAULTS.opencode)
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'before', content: 'First.' }, owner)
    await idle(conversation.id)
    const original = (await repository.active(conversation.id))!
    const changed = await setDefaults({ ...DEFAULT_HARNESS_DEFAULTS.opencode, advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!,
      permissionRules: [{ permission: 'shell', pattern: '*', effect: 'deny' }] } })
    await chat.send(conversation.id, { requestId: 'after', content: 'Continue.', configurationVersionId: original.operator_configuration_version_id,
      settings: operatorChatSettings(changed.value.operator.harness), defaultsRevision: changed.revision }, owner)
    expect((await idle(conversation.id)).lastResult?.outcome).toBe('succeeded')
    expect(openCode.sessions).toBe(1)
    expect(openCode.attachments).toBeGreaterThan(0)
    expect((await repository.active(conversation.id))?.native_session_id).toBe(original.native_session_id)
  })
  it('initializes a child exactly once after cancellation during preparation, before any prompt submission', async () => {
    const { source, request } = await handoff()
    let entered!: () => void
    const preparing = new Promise<void>((resolve) => { entered = resolve })
    let first = true
    const original = authority.prepare
    authority.prepare = async (manager, configuration, id, principalId, signal) => {
      if (id.startsWith('operator-fork:') && first) {
        first = false; entered()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      }
      return original(manager, configuration, id, principalId, signal)
    }
    const accepted = await chat.send(source.id, request, owner)
    const id = accepted.state.conversation.id
    await preparing
    await chat.cancel(id, request.requestId, owner)
    expect((await idle(id)).lastResult?.outcome).toBe('canceled')
    expect(openCode.prompts).toHaveLength(0)
    await chat.send(id, { requestId: 'actual-first', content: 'Resume after cancellation.' }, owner)
    await idle(id)
    await chat.send(id, { requestId: 'actual-second', content: 'Another message.' }, owner)
    await idle(id)
    expect(openCode.prompts).toHaveLength(2)
    expect(openCode.prompts[0]).toContain('Remember the release context.')
    expect(openCode.prompts[1]).not.toContain('Prior Operator conversation context.')
  })
  it('persists OpenCode public part boundaries, not user text or a duplicate final aggregate', async () => {
    await setDefaults(DEFAULT_HARNESS_DEFAULTS.opencode)
    openCode.chronology = true
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'parts', content: 'USER_TEXT_MUST_NOT_BECOME_ASSISTANT' }, owner)
    const state = await idle(conversation.id)
    expect(state.lastResult?.outcome).toBe('succeeded')
    const replies = state.messages.filter((message) => message.role === 'assistant')
    expect(replies.map((message) => message.content)).toEqual(['Before the tool.', 'After the tool.'])
    expect(replies.map((message) => message.nativeMessageId)).toEqual(['before-turn-1', 'after-turn-1'])
    expect(replies.every((message) => message.nativeParentMessageId === 'public-turn-1' && message.nativeMessageComplete)).toBe(true)
    expect(BigInt(replies[0]!.afterActivitySequence!)).toBeLessThan(BigInt(state.activities![0]!.sequence))
    expect(replies[1]!.afterActivitySequence).toBe(state.activities![0]!.sequence)
    const reloaded = await new PostgresOperatorConversationRepository(pool).get(conversation.id)
    expect(reloaded?.messages).toEqual(state.messages)
  })
  it('recovers a retryable receipt without qualification, setup, or a model turn', async () => {
    const conversation = await chat.create(owner)
    const request = { requestId: 'recover-only', content: 'Original command.' }
    await repository.beginTurn(conversation.id, request, owner.id)
    await repository.finish(conversation.id, request.requestId, { outcome: 'failed', error: { code: 'PREPARATION_FAILED', message: 'Not submitted', retryable: true } }, undefined, true)
    await setDefaults(DEFAULT_HARNESS_DEFAULTS.opencode)
    const qualify = vi.spyOn(authority, 'assertConfiguration').mockImplementation(() => { throw new Error('Installation unavailable') })
    const prepare = vi.spyOn(authority, 'prepare').mockRejectedValue(new Error('Installation unavailable'))
    const recovered = await chat.send(conversation.id, { ...request, recovery: 'receipt' }, owner)
    expect(recovered.replayed).toBe(true)
    expect(recovered.state.lastResult?.outcome).toBe('failed')
    expect(qualify).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled()
    expect(codex.turns + openCode.turns).toBe(0)
    await expect(chat.send(conversation.id, { requestId: 'unknown', content: 'Never admitted.', recovery: 'receipt' }, owner))
      .rejects.toMatchObject({ code: 'OPERATOR_RECEIPT_NOT_FOUND' })
    expect(await repository.hasTurn(conversation.id, 'unknown')).toBe(false)
  })
  it('authenticates the credential produced by real prepare and reads handoff history through MCP', async () => {
    const { source, request } = await handoff()
    const accepted = await chat.send(source.id, request, owner)
    const id = accepted.state.conversation.id
    await idle(id)
    const configuration = (await repository.configuration(accepted.state.conversation.operatorConfigurationVersionId!))!
    const native = new PostgresOperatorChatAuthority(pool, access, { assertChat() {} } as never, '/tmp/pr19-operator-fixture', 'http://127.0.0.1:3000/mcp')
    vi.spyOn(native, 'setup').mockResolvedValue({ harness: 'opencode', status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() })
    const environment = await native.prepare(openCode, configuration, id, owner.id, new AbortController().signal)
    const token = environment.variables[OPERATOR_MCP_ENVIRONMENT_VARIABLE]!
    const authenticated = await access.authenticate(token)
    expect(authenticated.grants.flatMap((grant) => grant.actions)).toContain('operator_handoff:read')
    expect(authenticated.grants.flatMap((grant) => grant.actions)).not.toContain('operator_chat:write')
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat } as unknown as OperatorServices } })
    const client = new Client({ name: 'pr19-real-delegation', version: '1' })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      const history = await client.callTool({ name: 'operator_handoff_history_get', arguments: {} })
      expect(history.isError).not.toBe(true)
      expect((history.structuredContent as { messages: Array<{ content: string }> }).messages.map((message) => message.content)).toContain('Remember the release context.')
      const narrowed = owner.grants.map((grant) => ({ ...grant, actions: grant.actions.filter((action) => action !== 'operator_chat:read') }))
      await pool.query('update management_principals set grants=$2::jsonb where id=$1', [owner.id, JSON.stringify(narrowed)])
      expect((await access.authenticate(token)).grants.flatMap((grant) => grant.actions)).not.toContain('operator_handoff:read')
      await access.revoke(owner.id)
      await expect(access.authenticate(token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally { await client.close(); await app.close(); await native.release(id) }
  })
})
