import {
  NATIVE_INTERACTION_FIXTURES,
  NativeHarnessCapabilitiesSchema,
  NativeHarnessEventSchema,
  NativeSessionReferenceSchema,
  PendingNativeInteractionSchema,
  type AgentHarness,
  type ApprovalResponseOption,
  type McpDetection,
  type NativeHarnessCapabilities,
  type NativeHarnessEvent,
  type NativeSessionReference,
  type PendingNativeInteraction,
} from '@graphql/contracts'

import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../modules/harnesses/port.js'

/** Deterministic rich-transport fixture shared by HAP-02–07 integration tests. */
export class DeterministicNativeSessionManager implements NativeHarnessSessionManager {
  readonly counters = { sessions: 0, attaches: 0, turns: 0, sideEffects: 0, deliveries: 0, cancellations: 0 }
  lastStart: NativeSessionStart | undefined
  private readonly events: NativeHarnessEvent[] = []
  private waiting: PendingNativeInteraction | undefined
  private terminalResult: NativeHistory['terminalResult']
  private correlationId: string | undefined

  constructor(readonly harness: AgentHarness) {}

  async capabilities(): Promise<NativeHarnessCapabilities> {
    return NativeHarnessCapabilitiesSchema.parse({
      provider: this.harness, providerVersion: this.harness === 'codex' ? '0.154.0' : '1.18.31',
      persistentSessions: true, reconnect: true, sameRequestResponses: true, cancellation: true,
      history: true, configurationInspection: true, mcpDetection: true, supportedInteractionKinds: ['approval'],
    })
  }

  async inspectMcp(): Promise<McpDetection> {
    return { harness: this.harness, serverName: 'graphql-app', state: 'connected', endpointMatches: true,
      credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', checkedAt: '2026-09-16T00:00:00.000Z' }
  }

  async createSession(input: NativeSessionStart): Promise<NativeSessionReference> {
    this.lastStart = input
    this.counters.sessions += 1
    return NativeSessionReferenceSchema.parse({
      harness: this.harness, providerVersion: this.harness === 'codex' ? '0.154.0' : '1.18.31',
      nativeSessionId: `${this.harness}-fixture-session`,
    })
  }

  async attachSession(session: NativeSessionReference, input: NativeSessionStart): Promise<NativeSessionReference> {
    if (session.harness !== this.harness) throw new Error('FIXTURE_SESSION_PROVIDER_MISMATCH')
    this.lastStart = input
    this.counters.attaches += 1
    return NativeSessionReferenceSchema.parse(session)
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput): AsyncIterable<NativeHarnessEvent> {
    this.correlationId = input.clientCorrelationId
    this.terminalResult = undefined
    await input.onSubmitted?.(`${this.harness}-fixture-turn`)
    this.counters.turns += 1
    this.counters.sideEffects += 1
    const source = NATIVE_INTERACTION_FIXTURES[this.harness]
    this.waiting = PendingNativeInteractionSchema.parse({
      session, turn: { nativeTurnId: `${this.harness}-fixture-turn`, nativeRequestId: source.nativeRequestId },
      nativeRequestType: source.nativeRequestType, request: source.request, responseOptions: source.responseOptions,
    })
    const event = NativeHarnessEventSchema.parse({
      sequence: this.events.length, type: 'interaction.pending', occurredAt: '2026-09-16T00:00:00.000Z',
      payload: { nativeRequestId: source.nativeRequestId },
    })
    this.events.push(event)
    yield event
  }

  async pending(): Promise<PendingNativeInteraction | undefined> { return this.waiting }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption): Promise<void> {
    void session
    if (this.waiting?.turn.nativeRequestId !== nativeRequestId || !this.waiting.responseOptions.some((item) => item.optionId === option.optionId)) {
      throw new Error('INVALID_FIXTURE_RESPONSE')
    }
    this.counters.deliveries += 1
    this.waiting = undefined
    this.terminalResult = { outcome: 'succeeded', output: { approvedOptionId: option.optionId } }
  }

  async cancel(): Promise<boolean> { this.counters.cancellations += 1; this.waiting = undefined; return true }
  async history(): Promise<NativeHistory> {
    return {
      ...(this.correlationId ? { correlationId: this.correlationId, nativeTurnId: `${this.harness}-fixture-turn`, nativeMessageId: `${this.harness}-fixture-answer` } : {}),
      events: [...this.events],
      pendingInteractions: this.waiting ? [this.waiting] : [],
      ...(this.waiting ? { pendingInteraction: this.waiting } : {}),
      ...(this.terminalResult ? { terminalResult: this.terminalResult } : {}),
    }
  }
  async reconcile(session: NativeSessionReference, correlationId: string): Promise<NativeHistory> {
    void session
    if (correlationId !== this.correlationId) return { events: [], pendingInteractions: [] }
    return this.history()
  }
  async close(): Promise<void> {}
}
