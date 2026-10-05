import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { isDeepStrictEqual as same } from 'node:util'
import type pg from 'pg'
import { MAX_FILE_BYTES, type AgentFilePublishInput, type AgentFilePublishResult } from '@graphql/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@graphql/contracts/byte-transfer'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { WorkerNativeOutputReplySchema, type WorkerNativeOutputCommand,
  type WorkerNativeOutputReply } from '@graphql/contracts/worker-native-output'
import { DomainError } from '../../errors.js'
import type { FileQuery } from '../../files/repository.js'
import { digest } from '../../files/tools/context.js'

export interface LocalOutputCaller { mainId: string; executionId: string; binding: string; principalId: string }
interface Output {
  artifact_id: string; binding: string; execution_id: string; description: {
    filename: string; mediaType: AgentFilePublishInput['mediaType']
  }; byte_size: number; sha256: string | null; publication: AgentFilePublishInput | null; retired_at: Date | null
}
const conflict = () => new DomainError('WORKER_NATIVE_OUTPUT_CONFLICT', 'The original native output command or handle changed.', 409)
const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE', 'The original native output is unavailable.', 409)

/** API-owned byte rows expose neither a path nor a database capability to the
 * native process. Each mutation and retry rechecks the original Worker caller. */
export class LocalWorkflowNativeOutputRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(caller: LocalOutputCaller, authorize: (sql: FileQuery) => Promise<void>,
    work: (sql: FileQuery) => Promise<T>): Promise<T> {
    const sql = await this.pool.connect()
    try {
      await sql.query('begin')
      await sql.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
      await authorize(sql)
      await sql.query('select pg_advisory_xact_lock(hashtextextended($1,285208))', [caller.mainId])
      const result = await work(sql)
      await authorize(sql)
      await sql.query('commit')
      return result
    } catch (error) { await sql.query('rollback'); throw error }
    finally { sql.release() }
  }

  private async output(sql: FileQuery, caller: LocalOutputCaller, artifactId: string): Promise<Output> {
    const row = (await sql.query<Output>(`select * from local_workflow_native_outputs
      where artifact_id=$1 and main_id=$2 and execution_id=$3 and binding=$4 for update`,
    [artifactId, caller.mainId, caller.executionId, caller.binding])).rows[0]
    if (!row || row.retired_at) throw unavailable()
    return row
  }

  private async command(sql: FileQuery, caller: LocalOutputCaller, commandId: string, inputHash: string) {
    const row = (await sql.query<{ input_hash: string; reply: unknown }>(`select input_hash,reply
      from local_workflow_native_output_commands where binding=$1 and command_id=$2 for update`,
    [caller.binding, commandId])).rows[0]
    if (row && row.input_hash !== inputHash) throw conflict()
    if (!row) {
      const count = (await sql.query<{ count: number }>(`select count(*)::int as count
        from local_workflow_native_output_commands where binding=$1`, [caller.binding])).rows[0]!.count
      if (count >= BYTE_TRANSFER_POLICY.maxRecords) throw unavailable()
      const total = (await sql.query<{ count: number }>(`select count(*)::int as count
        from local_workflow_native_output_commands c where exists(
          select 1 from local_workflow_native_outputs o where o.binding=c.binding
            and o.main_id=$1 and o.retired_at is null)`, [caller.mainId])).rows[0]!.count
      if (total >= BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal) throw unavailable()
    }
    return row?.reply == null ? undefined : WorkerNativeOutputReplySchema.parse(row.reply)
  }

  private async save(sql: FileQuery, caller: LocalOutputCaller, commandId: string, inputHash: string,
    reply: WorkerNativeOutputReply | null): Promise<void> {
    const saved = await sql.query(`insert into local_workflow_native_output_commands(execution_id,binding,command_id,input_hash,reply)
      values($1,$2,$3,$4,$5::jsonb) on conflict(binding,command_id) do update
      set reply=coalesce(local_workflow_native_output_commands.reply,excluded.reply)
      where local_workflow_native_output_commands.input_hash=excluded.input_hash`,
    [caller.executionId, caller.binding, commandId, inputHash, reply === null ? null : JSON.stringify(reply)])
    if (saved.rowCount !== 1) throw conflict()
    await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'mcp','workflow.native-output',$2,'succeeded',$3::jsonb)`, [caller.principalId,
      `execution:${caller.executionId}`, JSON.stringify({ commandId, phase: reply ? 'completed' : 'publication_reserved' })])
  }

  private async mutate(sql: FileQuery, caller: LocalOutputCaller,
    command: Exclude<WorkerNativeOutputCommand, { operation: 'publish' }>): Promise<WorkerNativeOutputReply> {
    if (command.operation === 'create') {
      const count = (await sql.query<{ count: number }>(`select count(*)::int as count
        from local_workflow_native_outputs where main_id=$1 and retired_at is null`, [caller.mainId])).rows[0]!.count
      if (count >= BYTE_TRANSFER_POLICY.maxRecords) throw unavailable()
      const artifactId = randomUUID()
      await sql.query(`insert into local_workflow_native_outputs(artifact_id,main_id,execution_id,binding,description)
        values($1,$2,$3,$4,$5::jsonb)`, [artifactId, caller.mainId, caller.executionId, caller.binding,
        JSON.stringify({ filename: command.filename, mediaType: command.mediaType })])
      return { operation: 'create', artifactId, byteSize: 0 }
    }
    const output = await this.output(sql, caller, command.artifactId)
    if (command.operation === 'seal') {
      if (!output.sha256) {
        const hash = createHash('sha256')
        for await (const bytes of this.chunks(sql, output)) hash.update(bytes)
        output.sha256 = hash.digest('hex')
        await sql.query('update local_workflow_native_outputs set sha256=$2 where artifact_id=$1',
          [output.artifact_id, output.sha256])
      }
      return { operation: 'seal', artifactId: output.artifact_id, sha256: output.sha256, byteSize: output.byte_size }
    }
    const bytes = Buffer.from(command.contentBase64, 'base64')
    if (output.sha256 || command.offset !== output.byte_size || output.byte_size + bytes.length > MAX_FILE_BYTES) throw conflict()
    const used = (await sql.query<{ size: string }>(`select coalesce(sum(byte_size),0)::text as size
      from local_workflow_native_outputs where main_id=$1 and retired_at is null`, [caller.mainId])).rows[0]!.size
    if (Number(used) + bytes.length > BYTE_TRANSFER_POLICY.maxStagingBytes) throw unavailable()
    if (bytes.length) await sql.query(`insert into local_workflow_native_output_chunks(artifact_id,byte_offset,bytes)
      values($1,$2,$3)`, [output.artifact_id, output.byte_size, bytes])
    const byteSize = output.byte_size + bytes.length
    await sql.query('update local_workflow_native_outputs set byte_size=$2 where artifact_id=$1', [output.artifact_id, byteSize])
    return { operation: 'append', artifactId: output.artifact_id, byteSize }
  }

  private async *chunks(sql: FileQuery, output: Output): AsyncGenerator<Buffer> {
    let offset = 0
    while (offset < output.byte_size) {
      const page = (await sql.query<{ byte_offset: number; bytes: Buffer }>(`select byte_offset,bytes
        from local_workflow_native_output_chunks where artifact_id=$1 and byte_offset>=$2
        order by byte_offset limit 64`, [output.artifact_id, offset])).rows
      if (!page.length) throw conflict()
      for (const chunk of page) {
        if (chunk.byte_offset !== offset || !chunk.bytes.length || offset + chunk.bytes.length > output.byte_size) throw conflict()
        offset += chunk.bytes.length
        yield chunk.bytes
      }
    }
  }

  async dispatch(caller: LocalOutputCaller, command: WorkerNativeOutputCommand,
    authorize: (sql: FileQuery) => Promise<void>, publish: (publication: AgentFilePublishInput, snapshot: {
      sha256: string; byteSize: number; open(): Promise<Readable>
    }) => Promise<AgentFilePublishResult>, scope: AgentFilePublishInput['scope']): Promise<WorkerNativeOutputReply> {
    const commandId = command.operation === 'publish' ? command.publication.commandId : command.commandId
    const inputHash = digest(canonicalGraphJson(command, 256 * 1024))
    if (command.operation !== 'publish') return this.transaction(caller, authorize, async sql => {
      const original = await this.command(sql, caller, commandId, inputHash)
      if (original) return original
      const reply = WorkerNativeOutputReplySchema.parse(await this.mutate(sql, caller, command))
      await this.save(sql, caller, commandId, inputHash, reply)
      return reply
    })
    const publication = { ...command.publication, scope }
    const output = await this.transaction(caller, authorize, async sql => {
      await this.command(sql, caller, commandId, inputHash)
      const original = await this.output(sql, caller, publication.artifactId)
      if (!original.sha256 || original.description.mediaType !== publication.mediaType
        || original.publication && !same(original.publication, publication)) throw conflict()
      await sql.query('update local_workflow_native_outputs set publication=$2::jsonb where artifact_id=$1',
        [original.artifact_id, JSON.stringify(publication)])
      await this.save(sql, caller, commandId, inputHash, null)
      return original
    })
    const repository = this
    const result = await publish(publication, { sha256: output.sha256!, byteSize: output.byte_size,
      open: async () => Readable.from((async function* () {
        await authorize(repository.pool)
        const hash = createHash('sha256')
        for await (const bytes of repository.chunks(repository.pool, output)) {
          await authorize(repository.pool)
          hash.update(bytes)
          yield bytes
        }
        if (hash.digest('hex') !== output.sha256) throw conflict()
        await authorize(repository.pool)
      })()) })
    const reply: WorkerNativeOutputReply = { operation: 'publish', result }
    await this.transaction(caller, authorize, async sql => { await this.save(sql, caller, commandId, inputHash, reply) })
    return reply
  }

  async retire(executionId: string): Promise<void> {
    const sql = await this.pool.connect()
    try {
      await sql.query('begin')
      const closed = await sql.query(`select 1 from execution_native_closures where execution_id=$1 and closed_at is not null
        and generation=(select max(generation) from execution_native_closures where execution_id=$1) for share`, [executionId])
      if (closed.rowCount !== 1) throw unavailable()
      const installations = (await sql.query<{ main_id: string }>(`select distinct main_id
        from local_workflow_native_outputs where execution_id=$1 order by main_id`, [executionId])).rows
      for (const installation of installations) {
        await sql.query('select pg_advisory_xact_lock(hashtextextended($1,285208))', [installation.main_id])
      }
      await sql.query(`delete from local_workflow_native_output_chunks where artifact_id in (
        select artifact_id from local_workflow_native_outputs where execution_id=$1)`, [executionId])
      await sql.query('delete from local_workflow_native_output_commands where execution_id=$1', [executionId])
      await sql.query('update local_workflow_native_outputs set retired_at=coalesce(retired_at,clock_timestamp()) where execution_id=$1',
        [executionId])
      await sql.query('commit')
    } catch (error) { await sql.query('rollback'); throw error }
    finally { sql.release() }
  }
}
