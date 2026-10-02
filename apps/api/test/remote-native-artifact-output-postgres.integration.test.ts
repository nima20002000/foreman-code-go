import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NativeArtifactOutputSchema } from '../src/modules/runs/remote/nativeArtifactOutputs.js'
import { PostgresNativeArtifactOutputRepository } from '../src/modules/runs/remote/nativeArtifactOutputPostgres.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `native_output_${randomUUID().replaceAll('-', '')}`
const operation = 'remote.native-artifact.output'

/** SQL receipt guards only; this does not manufacture a native artifact or qualify a host. */
describe.skipIf(!databaseUrl)('original native artifact output receipt SQL guards', () => {
  let admin: pg.Pool, pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/test/i.test(url.pathname)) throw new Error('Owned loopback TEST_DATABASE_URL required.')
    admin = new pg.Pool({ connectionString: databaseUrl })
    await admin.query(`create schema ${schema}`)
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    await applyApplicationMigrations(pool)
    await pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
      values ('owner-a','SQL fixture','operator',$1,'[]',clock_timestamp()+interval '1 hour'),
             ('owner-b','SQL fixture','operator',$2,'[]',clock_timestamp()+interval '1 hour')`, ['a'.repeat(64), 'b'.repeat(64)])
  })
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() } }
  })
  const insert = (principal: string, command: string, target: string, result: unknown, op = operation) => pool.query(`
    insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
    values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`, [principal, op, command, target, 'c'.repeat(64), JSON.stringify(result)])
  it('keeps one original slot across retries and principals, with distinct Main namespaces', async () => {
    const target = JSON.stringify(['main-a', 'execution', 'attempt', 'output'])
    await insert('owner-a', 'first', target, { fixture: 'original' })
    await Promise.all([insert('owner-a', 'retry', target, { fixture: 'changed' }), insert('owner-b', 'foreign', target, { fixture: 'foreign' })])
    const stored = await pool.query('select principal_id,result from management_command_receipts where operation=$1 and target_key=$2', [operation, target])
    expect(stored.rows).toEqual([{ principal_id: 'owner-a', result: { fixture: 'original' } }])
    expect((await insert('owner-a', 'other-main', JSON.stringify(['main-b', 'execution', 'attempt', 'output']), { fixture: 'other namespace' })).rowCount).toBe(1)
    expect((await pool.query('select count(*)::int as count from application_migrations where version=285205')).rows[0].count).toBe(1)
  })
  it('rejects mutation, deletion and retrofitting an ordinary receipt into a native output', async () => {
    const target = JSON.stringify(['main-a', 'execution', 'attempt', 'immutable'])
    await insert('owner-a', 'immutable', target, { fixture: 'original' })
    await expect(pool.query('update management_command_receipts set result=$1 where operation=$2 and target_key=$3', ['{}', operation, target])).rejects.toThrow('immutable')
    await expect(pool.query('delete from management_command_receipts where operation=$1 and target_key=$2', [operation, target])).rejects.toThrow('immutable')
    await insert('owner-a', 'ordinary', 'ordinary', { fixture: 'ordinary' }, 'fixture.ordinary')
    await expect(pool.query("update management_command_receipts set operation=$1 where operation='fixture.ordinary'", [operation])).rejects.toThrow('original command insertion')
    expect((await pool.query("update management_command_receipts set result='{}' where operation='fixture.ordinary'")).rowCount).toBe(1)
  })
  async function outputFixture() {
    // Explicit SQL-boundary facts. These rows are not native qualification or a physical publication.
    const suffix = randomUUID(), principalId = `sql-output-${suffix}`, mainId = randomUUID()
    const workspaceId = `workspace-${suffix}`, agentId = `agent-${suffix}`, configurationId = randomUUID(), conversationId = randomUUID()
    const producer = { workspaceId, workflowId: 'sql-workflow', runId: 'sql-run', nodeId: 'sql-node', executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'b'.repeat(64) }
    const scope = { kind: 'temporary' as const, chat: { kind: 'agent' as const, conversationId, agentId, workspaceId, workflowId: producer.workflowId, runId: producer.runId, executionId: producer.executionId } }
    const context: FileToolContext = { ownerPrincipalId: principalId, scope, nativeSessionId: 'sql-native', turnId: 'sql-turn', allowMutation: true, allowedTools: ['files.publish_result'] }
    const fileId = randomUUID(), revisionId = randomUUID(), transferId = randomUUID(), body = Buffer.from('SQL boundary fixture'), sha256 = createHash('sha256').update(body).digest('hex')
    const record = NativeArtifactOutputSchema.parse({ version: 1, producer, outputKey: 'report', commandId: 'sql-original-command', nativeIdentity: { nativeSessionId: context.nativeSessionId, turnId: context.turnId },
      publication: { ownerPrincipalId: principalId, requestId: randomUUID(), binding: bindingIdentity(context) }, pins: { fileId, revisionId, sha256, byteSize: body.length }, scope,
      transferReceipt: { version: 1, receiptId: randomUUID(), transferId, sha256, byteSize: body.length, verifiedAt: new Date().toISOString(), intent: { version: 1, mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), transferId, operationId: randomUUID(), executionId: producer.executionId, attemptId: producer.attemptId, placementHash: producer.placementHash, rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact', sha256, byteSize: body.length, manifestDigest: 'c'.repeat(64), chunkBytes: 1024, expiresAt: '2099-01-01T00:00:00.000Z' } } })
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("insert into management_principals(id,name,audience,token_hash,grants,expires_at) values($1,'SQL fixture','operator',$2,$3::jsonb,clock_timestamp()+interval '1 hour')", [principalId, createHash('sha256').update(suffix).digest('hex'), JSON.stringify([{ actions: ['agent_chat:write'], scope: { workspaceIds: [workspaceId] } }])])
      await client.query("insert into workspaces(id,record) values($1,'{}')", [workspaceId])
      await client.query("insert into agents(id,workspace_id,record) values($1,$2,'{}')", [agentId, workspaceId])
      await client.query("insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,'{}')", [configurationId, workspaceId, agentId])
      await client.query("insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,agent_configuration_version_id,harness,record) values($1,'agent',$1,$2,$3,'sql-node',$4,$5,'codex','{}')", [conversationId, workspaceId, producer.workflowId, agentId, configurationId])
      await client.query("insert into files(file_id,owner_principal_id,current_revision_id,scope_kind,chat_kind,conversation_id,agent_id,workspace_id,workflow_id,run_id,execution_id,state,created_at,retention_duration_seconds,expires_at) values($1,$2,$3,'temporary','agent',$4,$5,$6,$7,$8,$9,'ready',now(),3600,now()+interval '1 hour')", [fileId, principalId, revisionId, conversationId, agentId, workspaceId, producer.workflowId, producer.runId, producer.executionId])
      await client.query("insert into file_revisions(revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key) values($1,$2,'fixture.md','text/markdown',$3,$4,'agent_output',now(),$5)", [revisionId, fileId, body.length, sha256, randomUUID()])
      await client.query("insert into file_allocations(allocation_id,owner_principal_id,request_id,input_hash,file_id,revision_id,state,created_at) values($1,$2,$3,$4,$5,$6,'finalized',now())", [randomUUID(), principalId, record.publication.requestId, 'a'.repeat(64), fileId, revisionId])
      const link = { ...record.publication, context, ref: { fileId, revisionId }, transferReceipt: record.transferReceipt, publicationInputHash: 'a'.repeat(64), createdAt: new Date().toISOString() }
      await client.query('insert into file_tool_publications(owner_principal_id,request_id,binding,file_id,revision_id,record) values($1,$2,$3,$4,$5,$6::jsonb)', [principalId, record.publication.requestId, record.publication.binding, fileId, revisionId, JSON.stringify(link)])
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    const authorize = async (query: import('../src/modules/files/repository.js').FileQuery) => {
      requireAuthorization(await readLiveManagementPrincipal(query, principalId), 'agent_chat:write', { workspaceId })
    }
    return { record, mainId, principalId, authorize, repository: new PostgresNativeArtifactOutputRepository(pool, mainId) }
  }
  it('binds once with one audit, exact SQL retry and persisted readback, and rejects changed pins', async () => {
    const f = await outputFixture()
    expect(await f.repository.bind(f.record, f.authorize)).toEqual(f.record)
    expect(await new PostgresNativeArtifactOutputRepository(pool, f.mainId).bind(f.record, f.authorize)).toEqual(f.record)
    expect(await new PostgresNativeArtifactOutputRepository(pool, f.mainId).read(f.record.producer, f.record.outputKey)).toEqual(f.record)
    const target = JSON.stringify([f.mainId, f.record.producer.executionId, f.record.producer.attemptId, f.record.outputKey])
    expect((await pool.query('select count(*)::int as count from management_audit where action=$1 and target_key=$2', [operation, target])).rows[0].count).toBe(1)
    await expect(f.repository.bind({ ...f.record, commandId: 'changed-command' }, f.authorize)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(await f.repository.read(f.record.producer, f.record.outputKey)).toEqual(f.record)
  })
  it('rejects revoked SQL authority on retries and rolls back a newly inserted mapping at the commit fence', async () => {
    const f = await outputFixture()
    let calls = 0
    const revokeAtCommit: typeof f.authorize = async query => {
      if (++calls === 2) await query.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.principalId])
      await f.authorize(query)
    }
    await expect(f.repository.bind(f.record, revokeAtCommit)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(await f.repository.read(f.record.producer, f.record.outputKey)).toBeUndefined()
    expect((await pool.query('select count(*)::int as count from management_audit where principal_id=$1', [f.principalId])).rows[0].count).toBe(0)
    await f.repository.bind(f.record, f.authorize)
    await pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.principalId])
    await expect(f.repository.bind(f.record, f.authorize)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })
  it('rejects expired canonical retention on retries while retaining original output history', async () => {
    const f = await outputFixture()
    await f.repository.bind(f.record, f.authorize)
    await pool.query("update files set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where file_id=$1", [f.record.pins.fileId])
    await expect(f.repository.bind(f.record, f.authorize)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    expect(await f.repository.read(f.record.producer, f.record.outputKey)).toEqual(f.record)
  })

})
