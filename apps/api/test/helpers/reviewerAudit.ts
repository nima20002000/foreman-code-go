import assert from 'node:assert/strict'

import type {
  AgentConfigurationVersion, DurableInteraction, HarnessExecution, NativeHarnessEvent,
  NativeSessionReference, PendingNativeInteraction, ReviewJob,
} from '@graphql/contracts'

import type { IssuedWorkerCredential } from '../../src/modules/access/workerCredentials.js'
import { DomainError } from '../../src/modules/errors.js'
import type { ExecutionCredentialProvider } from '../../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../../src/modules/harnesses/port.js'
import type { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import type { PostgresInteractionCoordinationRepository, WriterFence } from '../../src/modules/interactions/coordination.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import type { PostgresInteractionRepository } from '../../src/modules/interactions/postgres.js'
import { ReviewerDispatcher } from '../../src/modules/interactions/reviewer.js'
import type { NativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'
import type { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { nativeLanes } from './nativeLanes.js'

export const session: NativeSessionReference = {
  harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'review-native-exact',
}
export const correlationId = 'review-correlation-exact'
export const providerId = 'review-turn-exact'
export const secret = 'injected-reviewer-scoped-credential'
export const historicalSecret = `opm_${'a'.repeat(43)}`
export const now = '2026-09-17T00:00:00.000Z'
export const event = (type: string, payload: Record<string, unknown> = {}, sequence = 0): NativeHarnessEvent => ({
  type, payload, sequence, occurredAt: now, connectionId: 'connection-exact',
})
export function terminal(correlation = correlationId): NativeHistory {
  return { correlationId: correlation, nativeTurnId: providerId, events: [], pendingInteractions: [],
    terminalTurn: { correlationId: correlation, providerId, result: { outcome: 'succeeded', output: { done: true } } } }
}
export function permission(): PendingNativeInteraction {
  return { session, turn: { nativeTurnId: providerId, nativeRequestId: 'review-permission-exact' },
    nativeRequestType: 'item/commandExecution/requestApproval', request: { command: `echo ${secret}` },
    responseOptions: [{ optionId: 'approve', label: 'Approve once', semantic: 'approve_once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }] }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 2_000 && !condition(); index += 1) await Promise.resolve()
  assert.ok(condition(), 'The asynchronous test boundary was not reached.')
}

/** Database and native transport are doubles; dispatch, evidence, fences, attach,
 * credential maintenance and redaction execute the production implementations. */
export async function reviewerFixture(options: { recovering?: boolean; workflow?: boolean; silent?: boolean; events?: number } = {}) {
  const configuration: AgentConfigurationVersion = {
    id: 'configuration-pinned', workspaceId: 'workspace-1', agentId: 'reviewer-1', version: 1,
    productRole: 'orchestrator', prompt: {}, assignedSkills: [], contentHash: 'sha256:fixture', createdAt: now,
    harness: { harness: 'codex', model: 'fixture-model', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' },
  }
  let execution: HarnessExecution = {
    id: 'execution-reviewer', runId: 'run-1', workflowNodeId: 'node-reviewer', agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: { accepted: true },
    workingDirectory: '/accepted/project', runtimeDirectory: '/accepted/runtime',
    nativeSessionId: session.nativeSessionId, state: options.workflow ? 'running' : 'completed',
    ...(options.workflow ? {} : { result: { outcome: 'succeeded' as const }, finishedAt: now }),
    createdAt: now, startedAt: now,
  }
  const run = { id: execution.runId, workspaceId: configuration.workspaceId, workflowId: 'workflow-1',
    executionState: 'waiting', outcome: 'pending',
    approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: execution.agentId } }
  let job: ReviewJob = {
    id: 'review-job-exact', interactionId: 'original-interaction', reviewerAgentId: execution.agentId,
    attempt: 0, state: options.recovering ? 'uncertain' : 'pending', provider: session.harness,
    nativeSessionId: session.nativeSessionId, correlationId, createdAt: now, updatedAt: now,
    ...(options.recovering ? { submittedAt: now } : {}),
  }
  const saved: { events: unknown[]; activity: unknown[]; executions: HarnessExecution[]; jobs: ReviewJob[] } = {
    events: [], activity: [], executions: [], jobs: [],
  }
  const hooks: {
    renew?: () => Promise<string>; validate?: () => Promise<void>; history?: () => Promise<NativeHistory>
    streamError?: Error; cancelError?: Error; closeError?: Error; attachError?: Error
    pending?: PendingNativeInteraction; lostJob: boolean; reviewPending: boolean; canceled: boolean
    countOnly: boolean; eventCount: number; validations: number
  } = { lostJob: false, reviewPending: !options.recovering, canceled: false, countOnly: false, eventCount: 0, validations: 0 }
  const silence = deferred()
  const starts: NativeTurnInput[] = []
  const attaches: NativeSessionStart[] = []
  const cancellations: { session: NativeSessionReference; nativeTurnId: string | undefined }[] = []
  let responds = 0
  let history: NativeHistory = options.recovering ? terminal() : { events: [], pendingInteractions: [] }
  const manager: NativeHarnessSessionManager = {
    harness: 'codex',
    async capabilities() { throw new Error('Capabilities were not needed by this test.') },
    async inspectMcp() { throw new Error('MCP inspection was not needed by this test.') },
    async createSession() { throw new Error('Reviewer must not create a replacement session.') },
    async attachSession(actual, input) {
      assert.deepEqual(actual, session)
      attaches.push(input)
      if (hooks.attachError) throw hooks.attachError
      return actual
    },
    async *startTurn(actual, input): AsyncIterable<NativeHarnessEvent> {
      assert.deepEqual(actual, session)
      starts.push(input)
      await input.onSubmitted?.(providerId)
      yield event('turn.started', { threadId: session.nativeSessionId, turnId: providerId, clientCorrelationId: input.clientCorrelationId })
      if (hooks.streamError) throw hooks.streamError
      for (let i = 0; i < (options.events ?? 0); i += 1) {
        yield event('item.delta', { text: `${secret} ${historicalSecret}` }, i + 1)
      }
      if (options.silent) await silence.promise
      hooks.reviewPending = false
      history = terminal(input.clientCorrelationId)
    },
    async pending() { return hooks.pending },
    async respond() { responds += 1 },
    async cancel(actual, _signal, nativeTurnId) {
      cancellations.push({ session: actual, nativeTurnId })
      if (hooks.cancelError) throw hooks.cancelError
      hooks.canceled = true
      delete hooks.pending
      silence.resolve()
      return true
    },
    async close() { if (hooks.closeError) throw hooks.closeError },
    async history() { return hooks.history ? hooks.history() : history },
    async reconcile(actual, expectedCorrelation) {
      assert.deepEqual(actual, session)
      if (hooks.history) return hooks.history()
      if (!starts.length && !options.recovering && !options.workflow) return { events: [event('session.idle')], pendingInteractions: [] }
      assert.equal(expectedCorrelation, options.workflow ? `execution:${execution.id}` : correlationId)
      return history
    },
  }
  const coordination = nativeLanes()
  await coordination.bindWorkflowSession(execution.id, session)
  await coordination.finalizeWorkflowSession(execution.id)
  await coordination.ensureLane({ id: 'review-lane', harness: session.harness, nativeSessionId: session.nativeSessionId,
    ownerAgentId: execution.agentId, observedStatus: 'idle', connectionGeneration: 0, observedAt: now, revision: 0 })
  const assertJob = async (id: string, token: string) => {
    if (hooks.lostJob || id !== job.id || token !== job.leaseToken || Date.parse(job.leaseExpiresAt ?? '') <= Date.now()) {
      throw new DomainError('REVIEW_JOB_LEASE_LOST', 'Lost job owner.', 409)
    }
  }
  Object.assign(coordination, {
    async reviewJobAgents() { return [job.reviewerAgentId] },
    async nextReviewJob() { return ['failed', 'completed'].includes(job.state) ? undefined : structuredClone(job) },
    async claimReviewJob(id: string, owner: string, token: string, expiresAt: string) {
      assert.equal(id, job.id)
      job = { ...job, state: ['submitted', 'acknowledged', 'uncertain'].includes(job.state) ? job.state : 'leased',
        attempt: job.attempt + 1, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expiresAt }
      return structuredClone(job)
    },
    async getReviewJobContext() { return { executionId: execution.id, workingDirectory: execution.workingDirectory!, providerVersion: session.providerVersion } },
    async isReviewPending() { return hooks.reviewPending },
    assertReviewJobLease: assertJob,
    async renewReviewJob(id: string, token: string, duration: number) {
      await assertJob(id, token)
      job.leaseExpiresAt = new Date(Date.now() + duration).toISOString()
      return job.leaseExpiresAt
    },
    async transitionReviewJob(id: string, token: string, state: ReviewJob['state'], fields: {
      providerTurnOrMessageId?: string; error?: ReviewJob['error']; cleanup?: ReviewJob['cleanup']; releaseLease?: boolean; writerFence?: WriterFence
    } = {}) {
      await assertJob(id, token)
      if (fields.writerFence) await coordination.assertLaneLease(fields.writerFence.id, fields.writerFence.token)
      if (job.providerTurnOrMessageId && fields.providerTurnOrMessageId) assert.equal(fields.providerTurnOrMessageId, job.providerTurnOrMessageId)
      job = { ...job, state, updatedAt: new Date().toISOString(),
        ...(state === 'submitted' ? { submittedAt: job.submittedAt ?? now } : {}),
        ...(state === 'acknowledged' ? { acknowledgedAt: job.acknowledgedAt ?? now } : {}),
        ...(state === 'completed' ? { completedAt: now } : {}),
        ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
        ...(fields.error ? { error: fields.error } : {}),
        ...(fields.cleanup ? { cleanup: fields.cleanup } : {}),
      }
      if (fields.releaseLease ?? ['failed', 'completed', 'blocked_busy', 'blocked_disconnected', 'uncertain'].includes(state)) {
        delete job.leaseOwner; delete job.leaseToken; delete job.leaseExpiresAt
      }
      saved.jobs.push(structuredClone(job))
      return structuredClone(job)
    },
    async appendReviewNativeEvent(_job: ReviewJob, native: NativeHarnessEvent) {
      hooks.eventCount += 1
      if (!hooks.countOnly) saved.events.push(structuredClone(native))
    },
  } satisfies Partial<PostgresInteractionCoordinationRepository>)
  const owner = { assertOwned() {}, client: {} } as unknown as RunOwnership
  const runs = {
    async get() { return structuredClone(run) },
    async getExecution() { return structuredClone(execution) },
    async getExecutionConfiguration() { return structuredClone(configuration) },
    async listExecutions() { return [structuredClone(execution)] },
    async updateExecution(value: HarnessExecution) { execution = structuredClone(value); saved.executions.push(structuredClone(value)) },
    async appendNativeEvent(value: unknown) { saved.events.push(structuredClone(value)) },
    async recordActivity(_runId: string, source: string, kind: string, payload: unknown) {
      saved.activity.push(structuredClone({ source, kind, payload }))
    },
  } as unknown as PostgresRunRepository
  const interactions = { coordination, async getForExecution() { return undefined },
    async cancelPendingForRun() {}, async cancelPendingForExecution() {},
  } as unknown as PostgresInteractionRepository
  const budgets = { async stop() {} } as unknown as PostgresApprovalBudgetRepository
  let resident = false
  const managers: NativeSessionManagerResolver = {
    resolve() { return { manager, get processState() { return resident ? 'resident' as const : 'needs_start' as const },
      beginStart() {}, markResident() { resident = true }, markFailed() {}, } },
    release() { resident = false },
  }
  const prepared: string[] = []
  const renewed: { executionId: string; principalId: string }[] = []
  const revoked: string[] = []
  const credential: IssuedWorkerCredential = { principalId: 'principal-reviewer-exact', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    environment: { agentId: execution.agentId, variables: { GRAPHQL_APP_MCP_TOKEN: secret } } }
  const credentials: ExecutionCredentialProvider = {
    async prepare(input) {
      prepared.push(input.purpose ?? 'workflow')
      return { credential, detection: { detection: { harness: 'codex', serverName: 'graphql-app', state: 'connected', endpointMatches: true,
        credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', checkedAt: now },
      runnerId: 'fixture', workingDirectory: input.workingDirectory, providerVersion: session.providerVersion, nativeFilters: {} } }
    },
    async renew(id, actual) {
      renewed.push({ executionId: id, principalId: actual.principalId })
      return hooks.renew ? hooks.renew() : new Date(Date.now() + 60_000).toISOString()
    },
    async revoke(actual) { revoked.push(actual.principalId) },
    async revokeForExecution(id) { revoked.push(`execution:${id}`); return 1 },
  }
  const runtime = new ApprovalExecutionCoordinator(runs, interactions, budgets, managers, 30_000, credentials, async () => {
    hooks.validations += 1
    await hooks.validate?.()
  })
  const dispatcher = new ReviewerDispatcher(coordination, runtime)
  return { dispatcher, runtime, coordination, manager, saved, hooks, starts, attaches, cancellations, prepared, renewed, revoked,
    owner, run, credential, configuration, finish: () => silence.resolve(),
    get responses() { return responds }, get execution() { return execution }, get job() { return job },
    setHistory(value: NativeHistory) {
      history = value
      if (value.terminalTurn && !value.pendingInteraction && value.pendingInteractions.length === 0) hooks.reviewPending = false
    },
    setJob(value: Partial<ReviewJob>) { job = { ...job, ...value } },
    attach(signal?: AbortSignal) { return runtime.attachOwnedSession({ harness: session.harness, agentId: execution.agentId,
      executionId: execution.id, workingDirectory: execution.workingDirectory!, purpose: 'reviewer', correlationId }, session, signal) },
    interaction: { id: 'waiting-interaction', executionId: execution.id, runId: run.id, requestingAgentId: execution.agentId,
      ...session, selectedOptionId: 'approve', selectedSemantic: 'approve_once',
      ...(options.workflow ? { status: 'delivered', deliveryState: 'delivered', deliveredAt: now }
        : { status: 'delivery_pending', deliveryState: 'uncertain' }) } as DurableInteraction,
  }
}
