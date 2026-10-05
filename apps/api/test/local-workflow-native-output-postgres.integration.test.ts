import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { WorkerNativeOutputCommand } from '@foreman-code/contracts/worker-native-output'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import type { TemporaryFileScope } from '@foreman-code/contracts/files'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { localWorkflowNativeOutputMigration } from '../src/infrastructure/localWorkflowNativeOutputMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import type { FileQuery } from '../src/modules/files/repository.js'
import { LocalWorkflowNativeOutputRepository, type LocalOutputCaller } from '../src/modules/runs/remote/localWorkflowNativeOutputRepository.js'
import { LocalWorkflowArtifactAuthority } from '../src/modules/runs/remote/localWorkflowArtifactAuthority.js'
import { assertOpenCodeNativeOutputCall } from '../src/modules/runs/remote/localWorkflowOutputApproval.js'
import type { NativeOutputCallCapture } from '../src/modules/harnesses/port.js'
import { runWorkHandoffWithRestart, workHandoffRuntimeFixture } from './helpers/workHandoffRuntimeFixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import type pg from 'pg'

// Byte-journal boundaries only. Native ownership, publication and MCP calls are
// exercised by the installed-provider acceptance cases.
async function fixture(pool: pg.Pool) {
  await applyApplicationMigrations(pool)
  const f = makeCurrentWorkflowFixture(`output-journal-${randomUUID()}`, 'sequential')
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [f.scope.workspaceId, JSON.stringify({ id: f.scope.workspaceId, name: 'Output journal' })])
  await pool.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
    [f.scope.workflowId, f.scope.workspaceId, JSON.stringify(f.version.definition)])
  for (const configuration of f.configurations) {
    await pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [configuration.agentId, f.scope.workspaceId, JSON.stringify({ id: configuration.agentId })])
    await pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
      values($1,$2,$3,1,$4::jsonb)`,
    [configuration.id, f.scope.workspaceId, configuration.agentId, JSON.stringify(configuration)])
  }
  await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
    values($1,$2,$3,1,$4,3,$5::jsonb)`,
  [f.version.id, f.scope.workspaceId, f.scope.workflowId, f.version.entryNodeId, JSON.stringify(f.version)])
  await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
    values($1,$2,$3,$4,'queued',$5::jsonb)`,
  [f.run.id, f.scope.workspaceId, f.scope.workflowId, f.version.id, JSON.stringify(f.run)])
  const access = new PostgresAccessService(pool)
  const writer = await access.issue({ name: 'Journal writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['agent_chat:write'],
      scope: { workspaceIds: [f.scope.workspaceId] } }] })
  const reader = await access.issue({ name: 'Journal reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['agent_chat:read'],
      scope: { workspaceIds: [f.scope.workspaceId] } }] })
  const mainId = randomUUID()
  const callers: LocalOutputCaller[] = []
  for (const node of f.version.definition.nodes.map(agentWorkflowNode)) {
    const executionId = randomUUID()
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,1,$5::jsonb)`, [executionId, f.run.id, node.id, node.agentId, JSON.stringify({
      id: executionId, runId: f.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId], attempt: 1,
      state: 'queued', input: {}, createdAt: f.createdAt,
    })])
    callers.push({ mainId, executionId, binding: createHash('sha256').update(executionId).digest('hex'),
      principalId: writer.principal.id })
  }
  const authorize = (principalId = writer.principal.id) => async (sql: FileQuery) => {
    requireAuthorization(await readLiveManagementPrincipal(sql, principalId), 'agent_chat:write',
      { workspaceId: f.scope.workspaceId })
  }
  const scope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent',
    conversationId: randomUUID(), workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
    agentId: f.configurations[0]!.agentId } }
  const repository = new LocalWorkflowNativeOutputRepository(pool)
  const dispatch = (command: WorkerNativeOutputCommand, caller = callers[0]!,
    principalId = writer.principal.id, storage = repository) => storage.dispatch(caller, command,
      authorize(principalId), async () => { throw new Error('Publication belongs to the real native acceptance path') }, scope)
  return { pool, mainId, callers, reader, writer, dispatch, repository }
}

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('PostgreSQL original native output byte journal', () => {
  it('upgrades an Operator database and replays accepted output commands after reconstruction', async () => {
    const db = await currentDatabase({ beforeMigration: localWorkflowNativeOutputMigration.version })
    try {
      const columns = 'select terminal_observation,terminal_history from operator_conversation_turns'
      const before = (await db.pool.query(columns)).rows
      const f = await fixture(db.pool)
      const create = { operation: 'create' as const, commandId: randomUUID(),
        filename: 'upgrade.md', mediaType: 'text/markdown' as const }
      const created = await f.dispatch(create)
      if (created.operation !== 'create') throw new Error('Create reply required')
      const bytes = Buffer.from('output after upgrade\n')
      await f.dispatch({ operation: 'append', commandId: randomUUID(), artifactId: created.artifactId,
        offset: 0, contentBase64: bytes.toString('base64') })
      const reconstructed = new LocalWorkflowNativeOutputRepository(db.pool)
      expect(await f.dispatch(create, f.callers[0], f.writer.principal.id, reconstructed)).toEqual(created)
      expect(await f.dispatch({ operation: 'seal', commandId: randomUUID(), artifactId: created.artifactId },
        f.callers[0], f.writer.principal.id, reconstructed)).toEqual({ operation: 'seal',
        artifactId: created.artifactId, byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') })
      expect((await db.pool.query(columns)).rows).toEqual(before)
    } finally { await db.close() }
  }, 120000)

  it.each(['artifact context', 'output approval'] as const)(
    'keeps %s reads from locking executions ahead of their Run after acceptance and restart', async boundary => {
    const definition = makeCurrentWorkflowFixture(randomUUID(), 'single')
    definition.version.definition.handoffs = { contractVersion: 1 }
    const f = await workHandoffRuntimeFixture(definition, () => ({ routing: { kind: 'finish' },
      data: { latestDeliverable: 'accepted work', remainingFindings: ['owner direction'] } }))
    let writer: pg.PoolClient | undefined
    let reader: pg.PoolClient | undefined
    let read: Promise<unknown> | undefined
    try {
      await runWorkHandoffWithRestart(f, true, () => true)
      const accepted = (await f.db.pool.query<{ id: string }>(
        'select id from harness_executions where run_id=$1 and accepted', [f.f.run.id])).rows
      expect(accepted).toHaveLength(1)
      const authority = new LocalWorkflowArtifactAuthority(randomUUID(), f.db.pool, f.locations,
        { assertPinsCurrent: async () => { throw new Error('A node without outputs cannot read artifact placement') } })
      writer = await f.db.pool.connect()
      reader = await f.db.pool.connect()
      const pid = (await reader.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await writer.query('begin')
      await writer.query('select id from runs where id=$1 for update', [f.f.run.id])
      await reader.query('begin')
      const capture: NativeOutputCallCapture = { descriptor: { nativeSessionId: 'unqualified',
        rootTurnId: 'unqualified', assistantMessageId: 'unqualified', callId: 'unqualified',
        toolName: 'files.native_output_create', nativeToolName: 'foreman-code_files_native_output_create',
        inputDigest: 'unqualified' }, effectivePolicy: 'ask', assertCurrent: () => undefined }
      read = boundary === 'artifact context' ? authority.execution(reader, accepted[0]!.id)
        : assertOpenCodeNativeOutputCall(reader, capture, { executionId: accepted[0]!.id,
          command: { operation: 'create', commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' } })
      const result = Promise.allSettled([read])
      let waiting = false
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (await f.db.pool.query<{ waiting: boolean }>(
          "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1", [pid])).rows[0]?.waiting === true
        if (waiting) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(waiting).toBe(true)
      expect((await writer.query('select id from harness_executions where id=$1 for update',
        [accepted[0]!.id])).rowCount).toBe(1)
      await writer.query('rollback')
      const [denied] = await result
      expect(denied).toMatchObject({ status: 'rejected', reason: { code: boundary === 'artifact context'
        ? 'NATIVE_ARTIFACT_AUTHORITY_DENIED' : 'WORKFLOW_OUTPUT_PERMISSION_DENIED' } })
    } finally {
      if (writer) { await writer.query('rollback'); writer.release() }
      if (read) await Promise.allSettled([read])
      if (reader) { await reader.query('rollback'); reader.release() }
      await f.close()
    }
  }, 120000)

  it('preserves create, append and seal replies across reconstruction while rejecting changed and denied calls', async () => {
    await nim2691TaskDatabase(async pool => {
      const f = await fixture(pool)
      const create = { operation: 'create' as const, commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' as const }
      const created = await f.dispatch(create)
      expect(created.operation).toBe('create')
      if (created.operation !== 'create') throw new Error('Create reply required')
      const recreated = new LocalWorkflowNativeOutputRepository(pool)
      expect(await f.dispatch(create, f.callers[0], f.writer.principal.id, recreated)).toEqual(created)
      const bytes = Buffer.from('original report\n')
      const append = { operation: 'append' as const, commandId: randomUUID(), artifactId: created.artifactId,
        offset: 0, contentBase64: bytes.toString('base64') }
      expect(await f.dispatch(append)).toMatchObject({ byteSize: bytes.length })
      expect(await f.dispatch(append, f.callers[0], f.writer.principal.id, recreated)).toMatchObject({ byteSize: bytes.length })
      const seal = { operation: 'seal' as const, commandId: randomUUID(), artifactId: created.artifactId }
      expect(await f.dispatch(seal, f.callers[0], f.writer.principal.id, recreated)).toEqual({ operation: 'seal',
        artifactId: created.artifactId, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      await expect(f.dispatch({ ...append, contentBase64: Buffer.from('changed').toString('base64') }))
        .rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
      await expect(f.dispatch({ ...create, commandId: randomUUID() }, f.callers[0], f.reader.principal.id))
        .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await expect(f.repository.retire(f.callers[0]!.executionId))
        .rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
      const retained = await pool.query<{ bytes: Buffer }>(
        'select bytes from local_workflow_native_output_chunks where artifact_id=$1', [created.artifactId])
      expect(retained.rows.map(row => row.bytes)).toEqual([bytes])
    })
  })

  it('shares the active output limit between concurrent executions and after reconstruction', async () => {
    await nim2691TaskDatabase(async pool => {
      const f = await fixture(pool)
      const first = f.callers[0]!
      await pool.query(`insert into local_workflow_native_outputs(artifact_id,main_id,execution_id,binding,description)
        select gen_random_uuid(),$1,$2,$3,$4::jsonb from generate_series(1,$5)`,
      [f.mainId, first.executionId, first.binding, JSON.stringify({ filename: 'held.md', mediaType: 'text/markdown' }),
        BYTE_TRANSFER_POLICY.maxRecords - 1])
      const create = () => ({ operation: 'create' as const, commandId: randomUUID(),
        filename: 'report.md', mediaType: 'text/markdown' as const })
      const attempts = await Promise.allSettled(f.callers.map(caller => f.dispatch(create(), caller)))
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
      await expect(f.dispatch(create(), first, f.writer.principal.id, new LocalWorkflowNativeOutputRepository(pool)))
        .rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
      expect((await pool.query<{ count: number }>(`select count(*)::int as count
        from local_workflow_native_outputs where main_id=$1 and retired_at is null`, [f.mainId])).rows[0]!.count)
        .toBe(BYTE_TRANSFER_POLICY.maxRecords)
    })
  })

  it('charges installation-wide retained command replies before either concurrent caller can allocate', async () => {
    await nim2691TaskDatabase(async pool => {
      const f = await fixture(pool)
      const first = f.callers[0]!
      // Retained storage facts model other original turns still holding quota;
      // these rows assert no native session or publication qualification.
      await pool.query(`insert into local_workflow_native_outputs(artifact_id,main_id,execution_id,binding,description)
        select gen_random_uuid(),$1,$2,md5('binding-'||n)||md5('scope-'||n),$3::jsonb
        from generate_series(1,$4) n`, [f.mainId, first.executionId,
        JSON.stringify({ filename: 'held.md', mediaType: 'text/markdown' }), BYTE_TRANSFER_POLICY.maxActiveGlobal])
      await pool.query(`insert into local_workflow_native_output_commands(execution_id,binding,command_id,input_hash,reply)
        select o.execution_id,o.binding,gen_random_uuid()::text,$2,
          jsonb_build_object('operation','append','artifactId',o.artifact_id,'byteSize',0)
        from local_workflow_native_outputs o cross join generate_series(1,$3) n where o.main_id=$1`,
      [f.mainId, 'a'.repeat(64), BYTE_TRANSFER_POLICY.maxRecords])
      const attempts = await Promise.allSettled(f.callers.map(caller => f.dispatch({ operation: 'create',
        commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' }, caller,
      f.writer.principal.id, new LocalWorkflowNativeOutputRepository(pool))))
      expect(attempts).toEqual([
        expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' }) }),
        expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' }) }),
      ])
      expect((await pool.query<{ count: number }>(
        'select count(*)::int as count from local_workflow_native_outputs where main_id=$1',
        [f.mainId])).rows[0]!.count).toBe(BYTE_TRANSFER_POLICY.maxActiveGlobal)
    })
  })
})
