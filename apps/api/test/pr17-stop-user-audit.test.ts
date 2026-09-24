import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { it, vi } from 'vitest'
import { ManagementPrincipalSchema } from '@graphql/contracts/management'
import type { DurableInteraction } from '@graphql/contracts'
import { DomainError } from '../src/modules/errors.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { InteractionService } from '../src/modules/interactions/service.js'
import { registerUserInteractions } from '../src/routes/userInteractions.js'

it('F11: failed cleanup remains retryable after terminal settlement and a fresh engine instance', async () => {
  let record: Record<string, unknown> = { id: 'run', executionState: 'waiting', outcome: 'pending' }
  let pending = false
  let fail = true
  let attempts = 0
  const owner = { client: {}, assertOwned() {}, async release() {} }
  const runs = {
    async requestCleanup() { pending = true },
    async hasPendingCleanup() { return pending },
    async finishCleanup(_id: string, failed: boolean) { pending = failed },
    async acquireOwnership() { return owner },
    async get() { return { ...record } },
    async settleOrphan(_id: string, _owner: unknown, canceled: boolean) {
      if (record.executionState === 'completed') return false
      record = { ...record, executionState: canceled ? 'completed' : 'interrupted', outcome: canceled ? 'canceled' : 'pending' }
      return true
    },
    async updateState(_id: string, update: Record<string, unknown>) { record = { ...record, ...update } },
  }
  const nativeExecutions = { residentRunIds: () => [], async cancelRun() { attempts++; if (fail) throw new Error('native close failed') } }
  const freshEngine = () => Object.assign(Object.create(LangGraphWorkflowEngine.prototype), {
    runs, nativeExecutions, activeRuns: new Map(), activeTasks: new Map(), resumeTasks: new Map(),
    workerCredentials: { async revokeForRun() {} },
  }) as LangGraphWorkflowEngine
  await assert.rejects(freshEngine().cancel('run'), /native close failed/)
  assert.equal(record.executionState, 'completed')
  assert.equal(pending, true)
  const outcome = record.outcome
  fail = false
  assert.equal(await freshEngine().cancel('run'), true)
  assert.equal(attempts, 3, 'the terminal owner makes a final fenced cleanup pass')
  assert.equal(pending, false)
  assert.equal(record.outcome, outcome, 'cleanup success must not rewrite the business outcome')
})

function userInteraction(): DurableInteraction {
  return { id: 'interaction-user', revision: 0, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    executionId: 'execution', requestingAgentId: 'coder', harness: 'codex', providerVersion: '0.154.0',
    nativeSessionId: 'session', nativeRequestId: 'request', nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: 'run', request: {}, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'choice', label: 'Approve once', semantic: 'approve_once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' }
}

it('F15: production User routes require a User bearer credential and expose actual response authority', async () => {
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? 403 : 500)
    .send({ error: error instanceof Error ? error.message : 'Unknown error' }))
  const record = userInteraction()
  const user = ManagementPrincipalSchema.parse({ id: 'user', name: 'Human', audience: 'user',
    grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: ['workspace'] } }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null })
  const readonly = ManagementPrincipalSchema.parse({ ...user, id: 'reader', grants: [{ actions: ['interactions:read'], scope: { workspaceIds: ['workspace'] } }] })
  const access = { authenticate: async (token: string | undefined, audience: string) => {
    assert.equal(audience, 'user')
    if (token === 'test-human') return user
    if (token === 'test-reader') return readonly
    throw new DomainError('AUTH_WRONG_AUDIENCE', 'A User bearer is required, not an Operator credential or cookie.', 403)
  } } as unknown as PostgresAccessService
  const respond = vi.fn(async (actor: { kind: string; principal?: { id: string } }) => {
    assert.equal(actor.kind, 'user'); assert.equal(actor.principal?.id, 'user')
    return { interaction: { ...record, revision: 1, selectedOptionId: 'choice', selectedSemantic: 'approve_once', nativeResponse: null,
      decidedAt: '2026-09-16T00:00:01.000Z', deliveredAt: '2026-09-16T00:00:02.000Z', status: 'delivered', deliveryState: 'delivered' }, replayed: false }
  })
  const interactions = { get: async () => record, respond } as unknown as InteractionService
  registerUserInteractions(app, access, interactions)
  const headers = { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:5173' }
  const url = `/api/user/interactions/${record.id}`
  try {
    const detail = await app.inject({ method: 'GET', url, headers: { ...headers, authorization: 'Bearer test-human' } })
    assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().canRespond, true)
    const reader = await app.inject({ method: 'GET', url, headers: { ...headers, authorization: 'Bearer test-reader' } })
    assert.equal(reader.statusCode, 200); assert.equal(reader.json().canRespond, false)
    for (const supplied of [{ authorization: 'Bearer operator-token' }, { cookie: 'graphql_operator=operator-cookie' }, { authorization: 'Bearer test-reader' }]) {
      const denied = await app.inject({ method: 'POST', url: `${url}/respond`, headers: { ...headers, ...supplied }, payload: { interactionId: record.id, optionId: 'choice', expectedRevision: 0 } })
      assert(denied.statusCode >= 400)
    }
    const foreign = await app.inject({ method: 'POST', url: `${url}/respond`, headers: { ...headers, origin: 'https://foreign.example', authorization: 'Bearer test-human' }, payload: { interactionId: record.id, optionId: 'choice', expectedRevision: 0 } })
    assert(foreign.statusCode >= 400)
    assert.equal(respond.mock.calls.length, 0)
    const accepted = await app.inject({ method: 'POST', url: `${url}/respond`, headers: { ...headers, authorization: 'Bearer test-human' }, payload: { interactionId: record.id, optionId: 'choice', expectedRevision: 0 } })
    assert.equal(accepted.statusCode, 200, accepted.body)
    assert.equal(respond.mock.calls.length, 1)
  } finally { await app.close() }
})
