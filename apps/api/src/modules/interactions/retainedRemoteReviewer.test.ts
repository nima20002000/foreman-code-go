import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HarnessExecutionSchema, ReviewJobSchema, type ReviewJob } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { remoteReviewerPolicy } from '../placement/remoteReviewerAuthority.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { finalizeRetainedRemoteReviewerLocked, readRecoverableRemoteReviewer,
  readRetainedRemoteReviewer } from './retainedRemoteReviewer.js'
import { ApprovalExecutionCoordinator } from './execution.js'
import type { RunOwnership } from '../runs/ownership.js'
import { RemoteNativeSessionManager } from '../runs/remote/nativeManagerProxy.js'
import { pageNativeHistory } from '../runs/remote/nativeHistoryPage.js'
import { nativeLanes } from '../../../test/helpers/nativeLanes.js'

vi.mock('../placement/persistence.js', () => ({ readExecutionPlacement: vi.fn() }))
vi.mock('../placement/remoteReviewerAuthority.js', () => ({
  remoteReviewerPolicy: vi.fn(), assertRemoteReviewerReceipt: vi.fn(async () => undefined),
}))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

// The placement/policy ports are validated fixtures. Session, original terminal,
// Worker grants and transactional retention use the production readers below.
function fixture() {
  const base = makeCurrentWorkflowFixture('reviewer-retention', 'approval')
  const node = base.version.definition.nodes.find(node => node.id === base.version.entryNodeId)!
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: base.run.id,
    workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: base.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, state: 'completed', createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), nativeSessionId: 'original-session', result: { outcome: 'succeeded' }, input: {},
    workingDirectory: '/project', runtimeDirectory: '/runtime' })
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
    terminal: true, lane: true, live: true, detached: false, closed: false,
    generation: '1', drift: false, lifetimeReads: 0 }
  const principal = { id: 'original-principal', name: 'Reviewer', audience: 'worker', agent_id: execution.agentId,
    expires_at: new Date(Date.now() + 60_000), revoked_at: null,
    grants: [{ actions: ['interactions:read', 'interactions:respond'],
      scope: { workspaceIds: [base.run.workspaceId], workflowIds: [base.run.workflowId], runIds: [base.run.id] } }] }
  let saved = { finalized: false, purpose: 'workflow' }
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const client = { async query(statement: string, values: unknown[] = []) {
    const text = statement.replace(/\s+/g, ' ').trim()
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
        live: !state.closed && (values[2] === true || state.live && !state.detached),
        detached: state.detached, reference: session }])
    }
    if (text.startsWith('select 1 from workflow_native_proofs')) return result(state.terminal ? [{}] : [])
    if (text.startsWith('select b.principal_id')) return result(state.revoked ? [] : [{ principal_id: principal.id }])
    if (text.startsWith('select id,name,audience')) return result([principal])
    if (text.includes('from review_jobs where execution_id=$1')) return result([])
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
  return { base, placement, session, execution, receipt, state, principal, connection, retain }
}

async function recoveryFixture() {
  const f = fixture()
  const coordination = nativeLanes()
  await coordination.bindWorkflowSession(f.execution.id, f.session)
  await coordination.finalizeWorkflowSession(f.execution.id)
  const owner = {
    runId: f.execution.runId, assertOwned() {}, oneShotConnection: () => f.connection,
    retain: () => async () => {}, release: async () => {},
  } as unknown as RunOwnership
  const worker = { receipt: structuredClone(f.receipt), authenticated: true, session: f.session,
    principalId: f.principal.id }
  const requests: string[] = []
  const credentials = { bindReviewerJob: vi.fn(async () => {
    if (!f.state.live || f.state.detached) throw new Error('Worker recovery must refresh its receipt before binding a review job')
  }), recoverRemote: vi.fn(async () => ({ principalId: worker.principalId,
    expiresAt: f.principal.expires_at.toISOString(),
    environment: { agentId: f.execution.agentId, variables: { GRAPHQL_MCP_TOKEN: 'original-token' } } })) }
  const closures = {
    begin: vi.fn(async () => {
      if (!f.state.detached) throw new Error('An open lifetime cannot be replaced')
      f.state.detached = false
      f.state.generation = String(Number(f.state.generation) + 1)
      return f.state.generation
    }),
    recordDetached: vi.fn(async () => { f.state.detached = true }),
  }
  const resident = vi.fn()
  const coordinator = () => {
    const manager = new RemoteNativeSessionManager({ intent: f.receipt.intent, placement: f.placement,
      harness: 'codex', configuration: f.base.configurations[0]!,
      transport: { async request(method) {
        requests.push(method)
        if (!worker.authenticated) throw new Error('Authenticated Worker connection unavailable')
        const status = { status: 'known', receipt: structuredClone(worker.receipt) }
        if (method === 'reattach') return { session: worker.session, status }
        if (method === 'get-application-access') return { status, applicationAccess: {
          kind: 'scoped-worker-mcp',
          executionId: f.execution.id, operationId: f.receipt.intent.operationId,
          attemptId: f.receipt.intent.attemptId, bindingHash: f.receipt.intent.bindingHash,
          agentId: f.execution.agentId, token: 'original-token',
        } }
        if (method === 'history') return { ...pageNativeHistory({ events: [], pendingInteractions: [] }), status }
        throw new Error(`Unexpected recovery request: ${method}`)
      } },
      async observeReceipt(receipt) {
        Object.assign(f.receipt, structuredClone(receipt))
        f.state.live = Date.parse(receipt.retainedReviewer!.expiresAt) > Date.now()
      },
      controlFor: async () => { throw new Error('Recovery cannot start or stop native work') },
    })
    type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
    return new ApprovalExecutionCoordinator({ getExecution: async () => f.execution,
      getExecutionConfiguration: async () => f.base.configurations[0],
      get: async () => ({ ...f.base.run, executionState: 'running', outcome: 'pending' }),
      acquireOwnership: async () => owner,
    } as unknown as Args[0], { coordination } as Args[1], {} as Args[2],
    { resolve: () => ({ manager, processState: 'resident', markResident: resident }) }, 60_000,
    credentials as unknown as Args[5], undefined, closures as unknown as Args[7],
    undefined, undefined, undefined, undefined, undefined,
    async context => ({ ...context, acceptedPlacement: f.placement }))
  }
  const attach = (main: ApprovalExecutionCoordinator, job?: ReviewJob) => main.attachOwnedSession({
    executionId: f.execution.id, agentId: f.execution.agentId, harness: 'codex',
    workingDirectory: f.execution.workingDirectory!, purpose: 'reviewer',
    ...(job ? { reviewJob: job } : {}),
  }, f.session)
  return { ...f, worker, requests, credentials, closures, resident, coordinator, attach }
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

describe('retained remote reviewer recovery', () => {
  it.each(['expired', 'detached'] as const)('requires Worker recovery before authorizing a %s reviewer', async state => {
    const f = fixture()
    try {
      if (state === 'expired') {
        f.state.live = false
        f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
      }
      if (state === 'detached') f.state.detached = true
      expect(await readRetainedRemoteReviewer(f.connection, f.execution)).toBeUndefined()
      expect(await readRecoverableRemoteReviewer(f.connection, f.execution)).toEqual({
        generation: '1', principalId: f.principal.id, session: f.session, detached: f.state.detached,
      })
      expect(f.state).toMatchObject({ finalized: false, purpose: 'workflow' })
    } finally { await f.connection.close() }
  })

  it('reattaches the original reviewer after graceful Main shutdown without closing its native lifetime', async () => {
    const f = await recoveryFixture()
    try {
      const first = f.coordinator()
      expect((await f.attach(first)).session).toEqual(f.session)
      await first.closeForRestart()
      expect(f.state.detached).toBe(true)
      const second = f.coordinator()
      expect((await f.attach(second)).session).toEqual(f.session)
      expect(f.closures.begin).toHaveBeenCalledTimes(1)
      expect(f.state).toMatchObject({ detached: false, closed: false, generation: '2' })
      expect(f.requests).toEqual(['reattach', 'get-application-access', 'history', 'reattach', 'get-application-access'])
      expect(f.credentials.recoverRemote.mock.results).toHaveLength(2)
      await second.closeForRestart()
      expect(f.closures.recordDetached).toHaveBeenCalledTimes(2)
    } finally { await f.connection.close() }
  })

  it('refreshes an expired Main receipt from the living original Worker reviewer', async () => {
    const f = await recoveryFixture()
    try {
      f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
      f.state.live = false
      f.worker.receipt.sequence++
      const main = f.coordinator()
      expect((await f.attach(main)).session).toEqual(f.session)
      expect(f.receipt.retainedReviewer!.expiresAt).toBe(f.worker.receipt.retainedReviewer!.expiresAt)
      expect(f.credentials.recoverRemote).toHaveBeenCalledTimes(1)
      expect(f.closures.begin).not.toHaveBeenCalled()
      expect(f.requests).toEqual(['reattach', 'get-application-access'])
      await main.closeForRestart()
    } finally { await f.connection.close() }
  })

  it('refreshes authenticated Worker evidence before rebinding the original reviewer to a recovered job', async () => {
    const f = await recoveryFixture()
    try {
      f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
      f.state.live = false
      f.worker.receipt.sequence++
      const now = new Date().toISOString()
      const job = ReviewJobSchema.parse({ id: 'recovered-review', interactionId: 'pending-interaction',
        reviewerAgentId: f.execution.agentId, attempt: 2, state: 'acknowledged', provider: f.session.harness,
        nativeSessionId: f.session.nativeSessionId, correlationId: 'original-review-turn',
        createdAt: now, updatedAt: now, leaseOwner: 'main', leaseToken: 'review-lease',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
      const main = f.coordinator()
      expect((await f.attach(main, job)).session).toEqual(f.session)
      expect(f.credentials.bindReviewerJob).toHaveBeenCalledTimes(2)
      expect(f.receipt.retainedReviewer!.expiresAt).toBe(f.worker.receipt.retainedReviewer!.expiresAt)
      expect(f.requests).toEqual(['reattach', 'get-application-access'])
      await main.closeForRestart()
    } finally { await f.connection.close() }
  })

  it.each(['unauthenticated', 'expiredWorker', 'changedSession', 'changedCredential', 'closed', 'missingTerminal'] as const)(
    'rejects recovery with %s evidence without making the reviewer resident', async failure => {
      const f = await recoveryFixture()
      try {
        f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
        f.state.live = false
        if (failure === 'unauthenticated') f.worker.authenticated = false
        if (failure === 'expiredWorker') f.worker.receipt.retainedReviewer!.expiresAt = f.receipt.retainedReviewer!.expiresAt
        if (failure === 'changedSession') f.worker.session = { ...f.session, nativeSessionId: 'replacement-session' }
        if (failure === 'changedCredential') f.worker.principalId = 'replacement-principal'
        if (failure === 'closed') f.state.closed = true
        if (failure === 'missingTerminal') f.state.terminal = false
        const main = f.coordinator()
        const errors = {
          unauthenticated: { message: 'Authenticated Worker connection unavailable' },
          expiredWorker: { code: 'REVIEWER_AUTHORITY_LOST' },
          changedSession: { message: 'Original remote session recovery required' },
          changedCredential: { code: 'REVIEWER_AUTHORITY_LOST' },
          closed: { code: 'REVIEWER_AUTHORITY_LOST' },
          missingTerminal: { code: 'REMOTE_REVIEWER_DENIED' },
        }
        await expect(f.attach(main)).rejects.toMatchObject(errors[failure])
        await expect(f.attach(main)).rejects.toMatchObject({
          code: failure === 'missingTerminal' ? 'REMOTE_REVIEWER_DENIED' : 'REVIEWER_AUTHORITY_LOST',
        })
        expect(f.resident).not.toHaveBeenCalled()
        expect(f.requests.every(method => ['reattach', 'get-application-access'].includes(method))).toBe(true)
        expect(f.closures.begin).not.toHaveBeenCalled()
      } finally { await f.connection.close() }
    },
  )
})
