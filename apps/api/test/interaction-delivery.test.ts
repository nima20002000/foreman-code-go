import assert from 'node:assert/strict'

import type { DurableInteraction, NativeSessionReference } from '@graphql/contracts'
import { it } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { matchingDeliveryEvidence, type InteractionDeliveryClaim, type NativeDeliveryOutcome, type NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import type { GraphResumeClaim } from '../src/modules/interactions/deliveryPostgres.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'
import { InteractionService } from '../src/modules/interactions/service.js'

function fixture(): DurableInteraction {
  return {
    id: 'interaction-proof', revision: 0, workspaceId: 'workspace-fixture', workflowId: 'workflow-fixture',
    runId: 'run-fixture', executionId: 'execution-fixture', requestingAgentId: 'agent-coder', harness: 'codex',
    providerVersion: '0.154.0', nativeSessionId: 'native-session', nativeRequestId: 'native-request',
    nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: 'run-fixture', graphInterruptId: 'interrupt-proof',
    request: { command: ['pnpm', 'test'] }, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'opaque-option', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  let record = fixture()
  let claim: InteractionDeliveryClaim | undefined
  let graphOwned = false
  let attempt = 0
  const control = {
    stopped: false, completedRun: false, timeout: false, crashCommit: false,
    resumeState: 'absent' as 'absent' | 'required' | 'completed' | 'canceled',
    resumeError: undefined as string | undefined,
    attemptState: undefined as NativeDeliveryOutcome['state'] | 'submitted' | undefined,
    history: { events: [], pendingInteractions: [] } as NativeHistory,
    onAttach: async () => undefined as void,
    onSend: async () => undefined as void,
    onResume: async (_interaction: DurableInteraction) => { void _interaction },
  }
  const calls = { sends: 0, attaches: 0, reconciles: 0, resumes: 0, asserts: 0, budgetResumes: 0 }
  const session: NativeSessionReference = {
    harness: record.harness, providerVersion: record.providerVersion, nativeSessionId: record.nativeSessionId,
  }
  const repository = {
    get: async () => structuredClone(record),
    decide: async (input: { optionId: string; expectedRevision: number }) => {
      if (record.selectedOptionId) return { interaction: structuredClone(record), replayed: true }
      assert.equal(input.expectedRevision, record.revision)
      record = { ...record, revision: record.revision + 1, selectedOptionId: input.optionId,
        selectedSemantic: 'approve_once', status: 'delivery_pending', deliveryState: 'pending' }
      return { interaction: structuredClone(record), replayed: false }
    },
    delivery: {
      claim: async (_id: string, ownerToken: string, reconcileOnly: boolean) => {
        if (claim || control.stopped || record.deliveryState === 'delivered') return undefined
        const mode = ['submitted', 'uncertain'].includes(record.deliveryState) ? 'reconcile' : 'submit'
        if (reconcileOnly && mode !== 'reconcile') return undefined
        if (mode === 'submit') attempt++
        control.attemptState = mode === 'submit' ? 'submitted' : 'uncertain'
        record = { ...record, revision: record.revision + 1, deliveryState: control.attemptState, status: 'delivery_pending' }
        claim = { interaction: structuredClone(record), attempt, ownerToken, correlationId: 'persisted-correlation', mode }
        return claim
      },
      finish: async (owned: InteractionDeliveryClaim, outcome: NativeDeliveryOutcome | ((current: DurableInteraction, signal: AbortSignal) => Promise<NativeDeliveryOutcome>)) => {
        assert.equal(owned.ownerToken, claim?.ownerToken)
        if (control.stopped) throw new DomainError('EXECUTION_STOPPED', 'stopped', 409)
        const result = typeof outcome === 'function' ? await outcome(structuredClone(record), new AbortController().signal) : outcome
        if (control.crashCommit) { control.crashCommit = false; throw new Error('database commit lost after native write') }
        control.attemptState = result.state
        record = { ...record, revision: record.revision + 1, deliveryState: result.state,
          status: result.state === 'delivered' ? 'delivered' : result.state === 'failed' ? 'delivery_failed' : 'delivery_pending' }
        if (result.state === 'delivered') control.resumeState = 'required'
        claim = undefined
        return structuredClone(record)
      },
      claimGraphResume: async (_id: string, ownerToken: string) => {
        if (control.resumeState !== 'required' || graphOwned) return undefined
        if (control.stopped || control.completedRun) {
          control.resumeState = control.stopped ? 'canceled' : 'completed'
          return undefined
        }
        if (!record.graphInterruptId) return undefined
        graphOwned = true
        return { interaction: structuredClone(record), ownerToken }
      },
      finishGraphResume: async (_owned: GraphResumeClaim, error?: string) => {
        control.resumeState = error === undefined ? 'completed' : 'required'
        control.resumeError = error
        graphOwned = false
      },
      recoveryCandidates: async () => [structuredClone(record)],
    },
  } as unknown as PostgresInteractionRepository
  const budgets = {
    assertActive: async () => {
      calls.asserts++
      if (control.timeout) throw new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'expired accounting', 409)
      if (control.stopped) throw new DomainError('EXECUTION_STOPPED', 'stopped', 409)
    },
    resume: async () => { calls.budgetResumes++ },
  } as unknown as PostgresApprovalBudgetRepository
  const runtime = {
    attachInteraction: async () => {
      calls.attaches++
      await control.onAttach()
      return { session, manager: {
        harness: 'codex',
        respond: async (actualSession: NativeSessionReference, requestId: string) => {
          assert.deepEqual(actualSession, session)
          assert.equal(requestId, record.nativeRequestId)
          calls.sends++
          await control.onSend()
        },
        reconcile: async (_session: NativeSessionReference, correlationId: string) => {
          assert.equal(correlationId, 'persisted-correlation')
          calls.reconciles++
          return control.history
        },
      } }
    },
  } as unknown as InteractionNativeRuntime
  const service = () => new InteractionService(repository, budgets, runtime, async (interaction) => {
    calls.resumes++
    await control.onResume(interaction)
  })
  const respond = (instance = service()) => instance.respond({ kind: 'user' }, {
    interactionId: record.id, optionId: 'opaque-option', expectedRevision: record.revision,
  })
  const proof = (): NativeResponseDeliveryEvidence => ({
    source: 'provider_history', harness: record.harness, providerVersion: record.providerVersion,
    nativeSessionId: record.nativeSessionId, nativeRequestId: record.nativeRequestId,
    nativeRequestType: record.nativeRequestType, optionId: 'opaque-option', semantic: 'approve_once',
  })
  return { control, calls, session, service, respond, proof, get: () => structuredClone(record),
    change: (fields: Partial<DurableInteraction>) => { record = { ...record, ...fields, revision: record.revision + 1 } },
    abandonOwner: () => { claim = undefined },
  }
}

it('keeps native delivery proven when graph resume fails and recovers without another native send (#7)', async () => {
  const h = harness()
  h.control.onResume = async () => { throw new Error('checkpoint database unavailable') }
  assert.equal((await h.respond()).interaction.deliveryState, 'delivered')
  assert.equal(h.control.attemptState, 'delivered')
  assert.equal(h.control.resumeState, 'required')
  assert.match(h.control.resumeError!, /checkpoint/)
  h.control.onResume = async () => undefined
  await h.service().recover({ limit: 10 })
  assert.equal(h.control.resumeState, 'completed')
  assert.equal(h.calls.sends, 1)
})

it('does not treat RUN_NOT_RESUMABLE as a successful graph handoff (#7/#8)', async () => {
  const h = harness()
  h.control.onResume = async () => { throw new DomainError('RUN_NOT_RESUMABLE', 'binding not ready', 409) }
  await h.respond()
  assert.equal(h.control.resumeState, 'required')
  assert.equal(h.get().deliveryState, 'delivered')
})

it('retains early delivery until interrupt binding and reloads the bound record (#8)', async () => {
  const h = harness()
  h.change({ graphInterruptId: undefined })
  await h.respond()
  assert.equal(h.calls.resumes, 0)
  assert.equal(h.control.resumeState, 'required')
  h.change({ graphInterruptId: 'bound-after-delivery' })
  h.control.onResume = async (current) => { assert.equal(current.graphInterruptId, 'bound-after-delivery') }
  await h.service().recover({ limit: 10 })
  assert.equal(h.calls.resumes, 1)
  assert.equal(h.calls.sends, 1)
})

it('does not lose a binding revision written during attachment (#8)', async () => {
  const h = harness()
  h.change({ graphInterruptId: undefined })
  h.control.onAttach = async () => { h.change({ graphInterruptId: 'racing-binding' }) }
  h.control.onResume = async (current) => { assert.equal(current.graphInterruptId, 'racing-binding') }
  await h.respond()
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.calls.resumes, 1)
})

it('does not reconcile or send over another live submission (#11)', async () => {
  const h = harness()
  const entered = deferred()
  const release = deferred()
  h.control.onSend = async () => { entered.resolve(); await release.promise }
  const first = h.respond()
  await entered.promise
  const duplicate = await h.respond(h.service())
  assert.equal(duplicate.replayed, true)
  assert.equal(h.calls.sends, 1)
  assert.equal(h.calls.reconciles, 0)
  release.resolve()
  await first
  assert.equal(h.control.resumeState, 'completed')
})

it('does not confuse absence or a terminal result with exact delivery evidence (#10)', async () => {
  const h = harness()
  h.control.onSend = async () => { throw Object.assign(new Error('write outcome unknown'), { certainty: 'uncertain' }) }
  await h.respond()
  h.control.history = { events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } }
  await h.respond()
  assert.equal(h.get().deliveryState, 'uncertain')
  assert.equal(h.control.attemptState, 'uncertain')
  assert.equal(h.calls.sends, 1)
  assert.equal(h.calls.resumes, 0)
})

it('reconciles the original attempt only with a qualified exact receipt (#10)', async () => {
  const h = harness()
  h.control.onSend = async () => { throw new Error('unknown native outcome') }
  await h.respond()
  h.control.history = { events: [], pendingInteractions: [], responseDeliveries: [h.proof()] }
  await h.respond()
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.control.attemptState, 'delivered')
  assert.equal(h.control.resumeState, 'completed')
  assert.equal(h.calls.sends, 1)
})

it('rejects receipts for another provider version, session, request, response, or source (#10)', async () => {
  const h = harness()
  await h.respond()
  const changes: Array<Partial<NativeResponseDeliveryEvidence>> = [
    { providerVersion: 'different' }, { harness: 'opencode' }, { nativeSessionId: 'different' },
    { nativeRequestId: 'different' }, { nativeRequestType: 'different' }, { optionId: 'different' }, { semantic: 'reject' },
    { source: 'local_pending_eviction' as NativeResponseDeliveryEvidence['source'] },
  ]
  for (const change of changes) {
    assert.equal(matchingDeliveryEvidence(h.get(), h.session, { events: [], pendingInteractions: [], responseDeliveries: [{ ...h.proof(), ...change }] }), undefined)
  }
})

it('treats contradictory pending state as uncertain even alongside a receipt (#10)', async () => {
  const h = harness()
  await h.respond()
  const record = h.get()
  assert.equal(matchingDeliveryEvidence(record, h.session, {
    events: [], responseDeliveries: [h.proof()], pendingInteractions: [{
      session: h.session, turn: { nativeTurnId: 'delivery-turn', nativeRequestId: record.nativeRequestId },
      nativeRequestType: record.nativeRequestType, request: record.request, responseOptions: record.responseOptions,
    }],
  }), undefined)
})

it('fences a response when Stop wins during attachment (#12)', async () => {
  const h = harness()
  h.control.onAttach = async () => {
    h.control.stopped = true
    h.change({ status: 'canceled' })
  }
  const result = await h.respond()
  assert.equal(result.interaction.status, 'canceled')
  assert.equal(h.calls.sends, 0)
  assert.equal(h.calls.resumes, 0)
})

it('does not resend after a process loses the delivery commit (#7/#11)', async () => {
  const h = harness()
  h.control.crashCommit = true
  await assert.rejects(h.respond(), /commit lost/)
  assert.equal(h.get().deliveryState, 'submitted')
  h.abandonOwner()
  h.control.history = { events: [], pendingInteractions: [], responseDeliveries: [h.proof()] }
  await h.service().recover({ limit: 10 })
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.control.resumeState, 'completed')
  assert.equal(h.calls.sends, 1)
})

it('allows a completed same-option replay without expired active-time accounting (#28)', async () => {
  const h = harness()
  await h.respond()
  const previous = { ...h.calls }
  h.control.timeout = true
  const result = await h.respond()
  assert.equal(result.replayed, true)
  assert.deepEqual(h.calls, previous)
})

it('settles an unacknowledged graph handoff for a terminal Run without touching its budget (#28)', async () => {
  const h = harness()
  await h.respond()
  h.control.resumeState = 'required'
  h.control.completedRun = true
  h.control.timeout = true
  const previous = { ...h.calls }
  await h.respond()
  assert.equal(h.control.resumeState, 'completed')
  assert.deepEqual(h.calls, previous)
})

it('still checks responder authority on delivered replays (#28)', async () => {
  const h = harness()
  await h.respond()
  h.change({ approval: { handler: 'operator' } })
  await assert.rejects(h.respond(), (error: unknown) => error instanceof DomainError && error.code === 'INTERACTION_ACCESS_DENIED')
})

it('rejects conflicting options rather than reusing another durable decision', async () => {
  const h = harness()
  await h.respond()
  h.change({ responseOptions: [...h.get().responseOptions, { ...h.get().responseOptions[0]!, optionId: 'different', semantic: 'reject' }] })
  await assert.rejects(h.service().respond({ kind: 'user' }, { interactionId: h.get().id, optionId: 'different', expectedRevision: 0 }),
    (error: unknown) => error instanceof DomainError && error.code === 'INTERACTION_ALREADY_DECIDED')
  assert.equal(h.calls.sends, 1)
})


it('keeps duplicate delivery and graph-resume ownership separate (#7/#11)', async () => {
  const h = harness()
  const entered = deferred()
  const release = deferred()
  h.control.onResume = async () => { entered.resolve(); await release.promise }
  const first = h.respond()
  await entered.promise
  try {
    const replay = await h.respond(h.service())
    assert.equal(replay.interaction.deliveryState, 'delivered')
    assert.equal(h.calls.sends, 1)
    assert.equal(h.calls.resumes, 1)
  } finally { release.resolve() }
  await first
})

it('treats the legacy pendingInteraction observation as a conflicting receipt (#10)', async () => {
  const h = harness()
  await h.respond()
  const current = h.get()
  assert.equal(matchingDeliveryEvidence(current, h.session, {
    events: [], pendingInteractions: [], responseDeliveries: [h.proof()], pendingInteraction: {
      session: h.session, turn: { nativeTurnId: 'delivery-turn', nativeRequestId: current.nativeRequestId }, nativeRequestType: current.nativeRequestType,
      request: current.request, responseOptions: current.responseOptions,
    },
  }), undefined)
})
