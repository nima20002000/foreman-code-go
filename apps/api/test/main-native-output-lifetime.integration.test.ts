import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { AcceptedMainArtifactPublication } from '../src/modules/files/distributed/publication.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import type { AuthorizedFileCaller } from '../src/modules/files/tools/types.js'
import { PostgresArtifactPublicationAuthority } from '../src/modules/runs/remote/nativeArtifactAuthority.js'
import { agent3Database, candidateFor, seedAgent3 } from './helpers/wave25Agent3.js'

async function fixture(options: { registeredSessionId?: string } = {}) {
  const db = await agent3Database()
  try {
    const saved = await seedAgent3(db.pool, db.directory)
    const session: NativeSessionReference = { harness: 'codex', providerVersion: 'unit', nativeSessionId: randomUUID() }
    const execution = { ...candidateFor(saved), state: 'running', nativeSessionId: session.nativeSessionId }
    await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`, [execution.id, execution.runId, execution.workflowNodeId,
      execution.agentId, execution.attempt, JSON.stringify(execution)])
    await db.pool.query('insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)',
      [execution.id, JSON.stringify(session)])
    await db.pool.query(`insert into execution_native_closures(execution_id,execution_identity,expected_reference)
      values($1,$2::jsonb,$3::jsonb)`, [execution.id, JSON.stringify({ id: execution.id }),
      options.registeredSessionId ? JSON.stringify({ ...session, nativeSessionId: options.registeredSessionId }) : null])
    const lane = { currentTurnOrMessageId: 'original-turn', correlationId: `execution:${execution.id}`,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }
    await db.pool.query(`insert into native_session_lanes(id,harness,native_session_id,owner_agent_id,record)
      values($1,'codex',$2,$3,$4::jsonb)`, [randomUUID(), session.nativeSessionId, execution.agentId, JSON.stringify(lane)])
    const mainId = randomUUID()
    const accepted: AcceptedMainArtifactPublication = {
      location: { kind: 'main', mainId },
      attempt: { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
        runId: execution.runId, nodeId: execution.workflowNodeId, executionId: execution.id,
        attemptId: randomUUID(), placementHash: 'a'.repeat(64) },
      context: { ownerPrincipalId: saved.run.authorizationPrincipalId!,
        scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: randomUUID(),
          workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
          runId: execution.runId, executionId: execution.id, agentId: execution.agentId } },
        nativeSessionId: session.nativeSessionId, turnId: 'original-turn', allowMutation: true,
        allowedTools: ['files.write_working_copy'] },
    }
    const authority = new PostgresArtifactPublicationAuthority(mainId, db.pool, {
      locations: { revalidateRunAuthorization: vi.fn() }, producer: { assertPinsCurrent: vi.fn() },
    })
    // Placement and file grants are separate public boundaries; exercise the lifetime SQL against migrated PostgreSQL.
    vi.spyOn(authority, 'authorizeMainNativeOutputDeclarations').mockResolvedValue(undefined)
    vi.spyOn(authority, 'resolveWorkflowContext').mockResolvedValue(accepted)
    vi.spyOn(authority, 'authorize').mockResolvedValue({ context: accepted.context,
      principal: { id: accepted.context.ownerPrincipalId }, binding: bindingIdentity(accepted.context) } as AuthorizedFileCaller)
    return { db, execution, session, accepted, lane,
      authorize: () => authority.authorizeMainNativeOutput(accepted.attempt, session.nativeSessionId,
        'original-turn', 'create', db.pool) }
  } catch (error) {
    await db.close()
    throw error
  }
}

it('authorizes the acknowledged Main turn whose immutable lifetime was initially unbound', async () => {
  const f = await fixture()
  try {
    expect(await f.authorize()).toEqual(f.accepted)
    const audits = await f.db.pool.query('select action from management_audit where target_key=$1',
      [`execution:${f.execution.id}`])
    expect(audits.rows).toEqual([{ action: 'native_output.authorize.create' }])
    const lifetime = await f.db.pool.query('select expected_reference from execution_native_closures where execution_id=$1',
      [f.execution.id])
    expect(lifetime.rows).toEqual([{ expected_reference: null }])
  } finally { await f.db.close() }
}, 20_000)

it.each(['session', 'turn', 'lease', 'closed', 'reference'] as const)('denies Main output after the original %s changes', async field => {
  const f = await fixture(field === 'reference' ? { registeredSessionId: 'different-session' } : {})
  try {
    if (field === 'session') await f.db.pool.query('delete from execution_native_sessions where execution_id=$1', [f.execution.id])
    if (field === 'turn' || field === 'lease') {
      const lane = { ...f.lane }
      if (field === 'turn') lane.currentTurnOrMessageId = 'different-turn'
      else lane.leaseExpiresAt = '2000-01-01T00:00:00.000Z'
      await f.db.pool.query('update native_session_lanes set record=$2::jsonb where native_session_id=$1',
        [f.session.nativeSessionId, JSON.stringify(lane)])
    }
    if (field === 'closed') await f.db.pool.query(`update execution_native_closures
      set closed_at=clock_timestamp(),closed_reference=$2::jsonb where execution_id=$1`,
    [f.execution.id, JSON.stringify(f.session)])
    await expect(f.authorize()).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    const audits = await f.db.pool.query('select 1 from management_audit where target_key=$1', [`execution:${f.execution.id}`])
    expect(audits.rows).toEqual([])
  } finally { await f.db.close() }
}, 20_000)
