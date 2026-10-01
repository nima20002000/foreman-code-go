import type pg from 'pg'
import { JobDefinitionSchema, JobExecutionSchema, JobLogChunkSchema, type JobDefinition, type JobExecution, type JobLogChunk } from '@graphql/contracts/jobs'
import { DomainError } from '../errors.js'
export type JobSql = Pick<pg.PoolClient, 'query'>

export class JobRepository {
  async definition(sql: JobSql, workspaceId: string, id: string, lock = false): Promise<JobDefinition> {
    const row = (await sql.query<{ record: unknown }>(`select record from job_definitions where workspace_id=$1 and id=$2${lock ? ' for update' : ''}`, [workspaceId,id])).rows[0]
    if (!row) throw new DomainError('JOB_DEFINITION_NOT_FOUND', 'The job definition was not found in this workspace.', 404)
    const definition = JobDefinitionSchema.parse(row.record)
    if (definition.id !== id || definition.workspaceId !== workspaceId) throw new DomainError('JOB_SCOPE_CONFLICT','Job definition scope conflicts with persistence.',409)
    return definition
  }
  async execution(sql: JobSql, workspaceId: string, id: string, lock = false): Promise<JobExecution> {
    const row = (await sql.query<{ record: unknown; accepted_spec: unknown }>(`select record,accepted_spec from job_executions where workspace_id=$1 and id=$2${lock ? ' for update' : ''}`, [workspaceId,id])).rows[0]
    if (!row) throw new DomainError('JOB_NOT_FOUND', 'The execution was not found in this workspace.', 404)
    const execution = JobExecutionSchema.parse(row.record)
    if (execution.id !== id || execution.workspaceId !== workspaceId || canonical(execution.acceptedSpec) !== canonical(row.accepted_spec)) throw new DomainError('JOB_SCOPE_CONFLICT','Job acceptance conflicts with persistence.',409)
    return execution
  }
  async putExecution(sql: JobSql, value: JobExecution): Promise<void> {
    const execution = JobExecutionSchema.parse(value)
    await sql.query('update job_executions set record=$3::jsonb where workspace_id=$1 and id=$2',[execution.workspaceId, execution.id, JSON.stringify(execution)])
  }
  async logs(sql: JobSql, executionId: string, after: number, limit: number) {
    const rows = await sql.query<{ sequence: string; attempt_id: string; stream: string; text: string; byte_size: number; created_at: Date }>(
      'select sequence::text,attempt_id,stream,text,byte_size,created_at from job_log_chunks where execution_id=$1 and sequence>$2 order by sequence limit $3', [executionId,after,limit])
    return rows.rows.map(row => JobLogChunkSchema.parse({executionId, attemptId: row.attempt_id, sequence:Number(row.sequence), stream:row.stream, text:row.text, byteSize:row.byte_size, createdAt:row.created_at.toISOString()}))
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item=>item===undefined?'null':canonical(item)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b]) => a<b?-1:a>b?1:0).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export function sameLog(left: JobLogChunk, right: JobLogChunk): boolean { return canonical(left) === canonical(right) }
