import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { remoteReviewerPolicy } from '../placement/remoteReviewerAuthority.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { finalizeRetainedRemoteReviewerLocked } from './retainedRemoteReviewer.js'

vi.mock('../placement/persistence.js', () => ({ readExecutionPlacement: vi.fn() }))
vi.mock('../placement/remoteReviewerAuthority.js', () => ({
  remoteReviewerPolicy: vi.fn(), assertRemoteReviewerReceipt: vi.fn(async () => undefined),
}))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

// The placement/policy ports are validated fixtures. Session, original terminal,
// Worker grants and transactional retention use the production readers below.
function fixture() {
  const base = makeCurrentWorkflowFixture('reviewer-retention')
  const node = base.version.definition.nodes.find(node => node.id === base.version.entryNodeId)!
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: base.run.id,
    workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: base.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, state: 'completed', createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), nativeSessionId: 'original-session', result: { outcome: 'succeeded' }, input: {} })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: execution.nativeSessionId! }
  const digest = 'a'.repeat(64)
  const intent = { schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(), runId: execution.runId,
    nodeId: node.id, executionId: execution.id, occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } }
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent,
    connection: { mainId: intent.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
    workerIncarnationId: randomUUID(), sequence: 1, phase: 'running', entryAttempted: true,
    turnEntryAttempted: true, stopFence: false, controls: [],
    native: { sessionId: session.nativeSessionId, turnId: 'original-turn', processIdentityDigest: digest },
    turnInput: { correlationId: `execution:${execution.id}`, promptDigest: digest },
    retainedReviewer: { agentId: execution.agentId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      workflowTurnId: 'original-turn', result: execution.result } })
  const placement = { hostRef: { kind: 'device' }, bindingHash: digest } as
    NonNullable<Awaited<ReturnType<typeof readExecutionPlacement>>>
  vi.mocked(readExecutionPlacement).mockResolvedValue(placement)
  vi.mocked(remoteReviewerPolicy).mockResolvedValue({ run: { ...base.run, executionState: 'running', outcome: 'pending' },
    version: base.version, configuration: base.configurations[0]!, execution, session, finalized: false })
  vi.mocked(readReconciledDispatchIntent).mockResolvedValue(receipt.intent)
  const state = { finalized: false, purpose: 'workflow', committed: false, revoked: false,
    terminal: true, lane: true, live: true, generation: '1', drift: false, lifetimeReads: 0 }
  const principal = { id: 'original-principal', name: 'Reviewer', audience: 'worker', agent_id: execution.agentId,
    expires_at: new Date(Date.now() + 60_000), revoked_at: null,
    grants: [{ actions: ['interactions:read', 'interactions:respond'],
      scope: { workspaceIds: [base.run.workspaceId], workflowIds: [base.run.workflowId], runIds: [base.run.id] } }] }
  let saved = { finalized: false, purpose: 'workflow' }
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const client = { async query(text: string, values: unknown[] = []) {
    if (text.startsWith('begin')) {
      saved = { finalized: state.finalized, purpose: state.purpose }
      return result([])
    }
    if (text === 'rollback') { Object.assign(state, saved); return result([]) }
    if (text === 'commit') { state.committed = true; return result([]) }
    if (text.startsWith('select r.receipt')) return result([{ receipt }])
    if (text.startsWith('select c.generation')) {
      state.lifetimeReads++
      return result([{ generation: state.drift && state.lifetimeReads > 1 ? '2' : state.generation,
        live: state.live, reference: session }])
    }
    if (text.startsWith('select 1 from workflow_native_proofs')) return result(state.terminal ? [{}] : [])
    if (text.startsWith('select b.principal_id')) return result(state.revoked ? [] : [{ principal_id: principal.id }])
    if (text.startsWith('select id,name,audience')) return result([principal])
    if (text.startsWith('update execution_native_sessions')) {
      expect(values).toEqual([execution.id, JSON.stringify(session)])
      state.finalized = true
      return result([{ execution_id: execution.id }])
    }
    if (text.startsWith("select record->>'connectionGeneration'")) return result(state.lane ? [{ generation: '1' }] : [])
    if (text.startsWith('update worker_credential_bindings')) {
      expect(values).toEqual([principal.id, execution.id, execution.agentId, session.nativeSessionId, '1'])
      state.purpose = 'reviewer'
      return result([{}])
    }
    throw new Error('Unexpected retention query')
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => undefined)
  const retain = () => connection.transaction(sql => finalizeRetainedRemoteReviewerLocked(sql, execution))
  return { execution, receipt, state, principal, connection, retain }
}

describe('atomic original remote reviewer retention', () => {
  it('commits finalized session and reviewer purpose together for the same Worker credential', async () => {
    const f = fixture()
    // Completed workflow-purpose credentials are ineligible until retention commits.
    expect(f.state.purpose).toBe('workflow')
    await f.retain()
    expect(f.state).toMatchObject({ finalized: true, purpose: 'reviewer', committed: true, revoked: false })
    expect(f.principal.id).toBe('original-principal')
    await f.connection.close()
  })
  it.each(['revoked', 'terminal', 'lane', 'drift', 'readOnly'] as const)('rolls back retention on %s', async field => {
    const f = fixture()
    if (field === 'revoked') f.state.revoked = true
    if (field === 'terminal') f.state.terminal = false
    if (field === 'lane') f.state.lane = false
    if (field === 'drift') f.state.drift = true
    if (field === 'readOnly') f.principal.grants[0]!.actions = ['interactions:read']
    await expect(f.retain()).rejects.toMatchObject({ code: field === 'readOnly'
      ? 'REVIEWER_CREDENTIAL_LOST' : 'REMOTE_REVIEWER_DENIED' })
    expect(f.state).toMatchObject({ finalized: false, purpose: 'workflow', committed: false })
    await f.connection.close()
  })
  it('does not retain an original session whose physical lifetime ended', async () => {
    const f = fixture()
    f.state.live = false
    await f.retain()
    expect(f.state).toMatchObject({ finalized: false, purpose: 'workflow' })
    await f.connection.close()
  })
})
