import {
  AgentConfigurationVersionSchema,
  DEFAULT_AGENT_DEFAULTS,
  DEFAULT_HARNESS_DEFAULTS,
  DurableInteractionSchema,
  // Execution request coverage is provided by native coordinator tests.
  HarnessWorkflowCompatibilitySchema,
  NATIVE_INTERACTION_FIXTURES,
  OperatorConfigurationVersionSchema,
  WorkflowDefinitionSchema,
  projectHarnessEffort,
  type AgentHarness,
  type HarnessConfiguration,
} from '@graphql/contracts'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { inTransaction } from '../src/infrastructure/transaction.js'
// Native execution/configuration coverage lives in native-runtime-consolidation.test.ts.
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { acceptedRunApproval } from '../src/modules/workflows/approval.js'
import { buildExecutableWorkflowVersion } from '../src/modules/workflows/executableVersion.js'
import { configurationInput } from '../src/modules/workspaces/agentConfiguration.js'
import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'

const now = '2026-09-16T00:00:00.000Z'
function configuration(agentId: string, productRole: 'orchestrator' | 'coder', harness = DEFAULT_HARNESS_DEFAULTS.codex as HarnessConfiguration) {
  return AgentConfigurationVersionSchema.parse({
    id: `${agentId}-config`, workspaceId: 'workspace', agentId, productRole,
    version: 1, harness, prompt: {}, assignedSkills: [], contentHash: 'fixture', createdAt: now,
  })
}
function executable() {
  const orchestratorHarness = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
  orchestratorHarness.advanced!.approvalPolicy = 'on-request'
  orchestratorHarness.advanced!.approvalsReviewer = 'auto_review'
  return {
    id: 'version', version: 1, createdAt: now,
    configurations: [configuration('orchestrator', 'orchestrator', orchestratorHarness), configuration('coder', 'coder')],
    definition: WorkflowDefinitionSchema.parse({
      id: 'workflow', workspaceId: 'workspace', name: 'Approval fixture',
      approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'orchestrator' },
      executionCondition: { kind: 'manual' },
      nodes: [{ id: 'first', name: 'Orchestrator', agentId: 'orchestrator' }, { id: 'second', name: 'Coder', agentId: 'coder' }],
      edges: [{ id: 'handoff', source: 'first', target: 'second' }],
    }),
  }
}

describe('PR8 executable approval acceptance', () => {
  it('uses accepted roles, preserves approval on omission and clones Run authority', () => {
    const input = executable()
    const previousDefinition = input.definition
    const definition = { ...previousDefinition, approval: undefined }
    const version = buildExecutableWorkflowVersion({ ...input, definition, previousDefinition })
    expect(version.approval).toEqual(previousDefinition.approval)
    const snapshot = acceptedRunApproval(version)!
    version.approval!.handler = 'user'
    expect(snapshot.handler).toBe('orchestrator')
  })

  it.each([
    ['missing designation', 'WORKFLOW_APPROVAL_INCOMPLETE'],
    ['wrong workflow', 'APPROVAL_ORCHESTRATOR_WRONG_WORKFLOW'],
    ['wrong role', 'APPROVAL_ORCHESTRATOR_ROLE_REQUIRED'],
    ['no coder', 'APPROVAL_DISTINCT_CODER_REQUIRED'],
  ])('rejects %s', (scenario, code) => {
    const input = executable()
    if (scenario === 'missing designation') input.definition.approval = { handler: 'orchestrator' }
    if (scenario === 'wrong workflow') input.definition.approval!.designatedOrchestratorAgentId = 'elsewhere'
    if (scenario === 'wrong role') input.configurations[0]!.productRole = 'coder'
    if (scenario === 'no coder') input.configurations[1]!.productRole = 'orchestrator'
    expect(() => buildExecutableWorkflowVersion(input)).toThrow(expect.objectContaining({ code }))
  })

  it('allows a self-reviewed Codex Coder in an Orchestrator-routed workflow', () => {
    const input = executable()
    const selfReviewed = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
    selfReviewed.advanced!.approvalsReviewer = 'auto_review'
    input.configurations[1] = configuration('coder', 'coder', selfReviewed)
    expect(() => buildExecutableWorkflowVersion(input)).not.toThrow()
  })

  it('rejects missing or mismatched configured snapshots but retains true legacy versions', () => {
    const version = buildExecutableWorkflowVersion(executable())
    expect(() => acceptedRunApproval({ ...version, approval: undefined })).toThrow(/inconsistent/)
    expect(() => acceptedRunApproval({ ...version, approval: { handler: 'user' } })).toThrow(/inconsistent/)
    expect(acceptedRunApproval({ ...version, approval: undefined, definition: { ...version.definition, approval: undefined } })).toBeUndefined()
  })

  it.each([false, true])('rejects legacy automatic OpenCode approval; Advanced present=%s', (advanced) => {
    const harness = structuredClone(DEFAULT_HARNESS_DEFAULTS.opencode)
    harness.autoApprove = true
    if (advanced) harness.advanced!.permissionHandling = 'native_auto'
    else delete harness.advanced
    for (const handler of ['user', 'operator', 'orchestrator']) {
      expect(HarnessWorkflowCompatibilitySchema.safeParse({ configuration: harness, workflowApprovalHandler: handler }).success).toBe(false)
    }
    expect(HarnessWorkflowCompatibilitySchema.safeParse({ configuration: harness }).success).toBe(true)
  })
})

describe('PR8 native settings and exact variants', () => {

  it('never replaces a native variant with a stale legacy effort projection', () => {
    const harness = { ...DEFAULT_HARNESS_DEFAULTS.opencode, variant: 'provider-custom-effort' }
    expect(projectHarnessEffort(harness)).toBeUndefined()
    expect(configurationInput('workspace', { id: 'agent', name: 'Agent', harness: 'opencode', effort: 'max', harnessConfiguration: harness }).harness)
      .toMatchObject({ variant: 'provider-custom-effort' })
  })
})

describe('PR8 durable schema and transaction boundaries', () => {
  it('rejects undecided deliveries, incomplete decisions and terminal-state contradictions', () => {
    const base = structuredClone(NATIVE_INTERACTION_FIXTURES.codex)
    expect(DurableInteractionSchema.safeParse({ ...base, status: 'delivered', deliveryState: 'delivered', deliveredAt: now }).success).toBe(false)
    expect(DurableInteractionSchema.safeParse({ ...base, status: 'delivery_pending', deliveryState: 'submitted' }).success).toBe(false)
    const decided = { ...base, status: 'delivery_pending', deliveryState: 'pending',
      selectedOptionId: base.responseOptions[0]!.optionId, selectedSemantic: base.responseOptions[0]!.semantic,
      nativeResponse: { decision: 'accept' }, decidedAt: now }
    expect(DurableInteractionSchema.safeParse(decided).success).toBe(true)
    expect(DurableInteractionSchema.safeParse({ ...decided, nativeResponse: undefined }).success).toBe(false)
    expect(DurableInteractionSchema.safeParse({ ...decided, deliveredAt: now }).success).toBe(false)
  })

  it('rejects undefined nativeResponse before acquiring a connection', async () => {
    const connect = vi.fn()
    const repository = new PostgresInteractionRepository({ connect } as unknown as pg.Pool)
    await expect(repository.decide({ id: 'interaction', optionId: 'option', expectedRevision: 0, nativeResponse: undefined })).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([
    ['owner', '', '2099-01-01T00:00:00.000Z'],
    ['', 'token', '2099-01-01T00:00:00.000Z'],
    ['owner', 'token', 'not-a-time'],
    ['owner', 'token', '2000-01-01T00:00:00.000Z'],
  ])('validates both lease claims before writes (%s, %s, %s)', async (owner, token, expiry) => {
    const connect = vi.fn()
    const repository = new PostgresInteractionCoordinationRepository({ connect } as unknown as pg.Pool)
    await expect(repository.claimReviewJob('job', owner, token, expiry)).rejects.toThrow()
    await expect(repository.claimLane('lane', 0, owner, token, expiry, 'correlation')).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  })

  it('isolates missing-default results from the compiled defaults and later readers', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const repository = new PostgresFoundationSettingsRepository({ query } as unknown as pg.Pool)
    const first = await repository.getAgentDefaults()
    first.value.coder.harness.model = 'mutated'
    expect((await repository.getAgentDefaults()).value).toEqual(DEFAULT_AGENT_DEFAULTS)
    expect((await repository.getAgentDefaults()).revision).toBe(0)
  })

  it('never commits, rolls back or releases the caller transaction', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const client = { query } as unknown as pg.ClientBase
    const connect = vi.fn()
    const pool = { connect } as unknown as pg.Pool
    await expect(inTransaction(pool, client, async () => 42)).resolves.toBe(42)
    await expect(inTransaction(pool, client, async () => { throw new Error('receipt failure') })).rejects.toThrow('receipt failure')
    expect(query).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
})

function operatorStart(harness: AgentHarness) {
  return {
    kind: 'operator' as const, correlationId: 'conversation', workingDirectory: '/tmp/operator',
    configuration: OperatorConfigurationVersionSchema.parse({
      id: 'operator-config', operatorId: 'operator', version: 1,
      harness: DEFAULT_HARNESS_DEFAULTS[harness], contentHash: 'sha256:fixture', createdAt: now,
    }),
  }
}
async function drain(source: AsyncIterable<unknown>) { for await (const event of source) void event }

describe.each(['codex', 'opencode'] as const)('PR8 %s native fixture isolation', (harness) => {
  it('keeps identities, pending work, responses, cancellation and history scoped', async () => {
    const manager = new DeterministicNativeSessionManager(harness)
    const a = await manager.createSession(operatorStart(harness))
    const b = await manager.createSession(operatorStart(harness))
    expect(a.nativeSessionId).not.toBe(b.nativeSessionId)
    await drain(manager.startTurn(a, { prompt: 'A', clientCorrelationId: 'turn-a' }))
    await drain(manager.startTurn(b, { prompt: 'B', clientCorrelationId: 'turn-b' }))
    const pendingA = (await manager.pending(a))!
    const pendingB = (await manager.pending(b))!
    expect(pendingA.turn.nativeRequestId).not.toBe(pendingB.turn.nativeRequestId)
    await expect(manager.respond(a, pendingB.turn.nativeRequestId!, pendingB.responseOptions[0]!)).rejects.toThrow()
    await manager.cancel(a)
    expect(await manager.pending(a)).toBeUndefined()
    expect(await manager.pending(b)).toEqual(pendingB)
    expect((await manager.reconcile(b, 'turn-a')).events).toEqual([])
    expect((await manager.history(b)).events).toHaveLength(1)
    await manager.respond(b, pendingB.turn.nativeRequestId!, pendingB.responseOptions[0]!)
    await drain(manager.startTurn(b, { prompt: 'Next', clientCorrelationId: 'turn-c' }))
    expect((await manager.pending(b))!.turn.nativeTurnId).not.toBe(pendingB.turn.nativeTurnId)
    expect((await manager.pending(b))!.turn.nativeRequestId).not.toBe(pendingB.turn.nativeRequestId)
    expect((await manager.reconcile(b, 'turn-b')).pendingInteractions).toEqual([])
    expect((await manager.reconcile(b, 'turn-c')).pendingInteractions).toHaveLength(1)
    const effects = manager.counters.sideEffects
    await drain(manager.startTurn(b, { prompt: 'Next', clientCorrelationId: 'turn-c' }))
    expect(manager.counters.sideEffects).toBe(effects)
    const copy = (await manager.pending(b))!
    copy.responseOptions.length = 0
    expect((await manager.pending(b))!.responseOptions.length).toBeGreaterThan(0)
    await manager.attachSession(b, operatorStart(harness))
    expect((await manager.history(b)).events).toHaveLength(3)
  })
})
