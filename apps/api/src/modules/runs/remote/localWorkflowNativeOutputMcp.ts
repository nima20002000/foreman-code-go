import type pg from 'pg'
import type { McpServer } from '@modelcontextprotocol/server'
import type { FastifyRequest } from 'fastify'
import { setTimeout as delay } from 'node:timers/promises'
import { z, ZodError } from 'zod'
import { effectiveGraphqlTools } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, WorkerNativeOutputToolInputSchemas, parseNativeOutputToolCommand,
  WorkerNativeOutputReplySchema,
  type WorkerNativeOutputCommand, type WorkerNativeOutputOperation } from '@graphql/contracts/worker-native-output'
import type { WorkerArtifactMcpExtension } from '../../../mcp/unified/transport.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import type { FileQuery } from '../../files/repository.js'
import type { NativeOutputCallCapture } from '../../harnesses/port.js'
import { assertWave25WorkerBinding } from '../../interactions/wave25/credentialAuthority.js'
import { LocalWorkflowNativeOutputRepository } from './localWorkflowNativeOutputRepository.js'
import { workflowArtifactsAreLocal } from './localWorkflowArtifactAuthority.js'
import type { LocalWorkflowArtifacts } from './localWorkflowArtifacts.js'
import { openCodeWorkflowOutputAllowed } from './localWorkflowOutputPolicy.js'

interface Ports {
  pool: pg.Pool
  artifacts(): LocalWorkflowArtifacts
  commands: Pick<PostgresCommandCoordinator, 'recordDenied'>
  nativeCall(executionId: string, toolName: string, args: unknown, signal: AbortSignal): Promise<NativeOutputCallCapture>
  authorizeNativeCall(sql: FileQuery, executionId: string, command: WorkerNativeOutputCommand,
    call: NativeOutputCallCapture): Promise<void>
}
const callSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.string(), arguments: z.unknown().optional() }).passthrough(),
}).passthrough()
const operations = ['create', 'append', 'seal', 'publish'] as const
const denied = () => new DomainError('WORKFLOW_ARTIFACT_TOOL_DENIED', 'This native execution cannot use the requested output tool.', 403)

/** The existing Worker credential supplies execution ownership. Arguments have
 * no scope, session, permission, native call identity or host path fields. */
export class LocalWorkflowNativeOutputMcp implements WorkerArtifactMcpExtension {
  private readonly repository: LocalWorkflowNativeOutputRepository
  constructor(private readonly ports: Ports) { this.repository = new LocalWorkflowNativeOutputRepository(ports.pool) }

  private async auditDenied(principal: ManagementPrincipal, tool: string, error: unknown): Promise<void> {
    if (error instanceof ZodError || error instanceof DomainError && error.status < 500) {
      await this.ports.commands.recordDenied(principal.id, 'mcp', tool, 'native-output')
    }
  }

  private async binding(principal: ManagementPrincipal, sql: FileQuery = this.ports.pool) {
    if (principal.audience !== 'worker') throw denied()
    await assertWave25WorkerBinding(sql, principal.id)
    const row = (await sql.query<{ execution_id: string; native_session_id: string | null }>(
      `select execution_id,approval_native_session_id as native_session_id from worker_credential_bindings
       where principal_id=$1 and agent_id=$2 and purpose='workflow' and revoked_at is null for share`,
      [principal.id, principal.agentId])).rows[0]
    if (!row) throw denied()
    return row
  }

  async isLocal(principal: ManagementPrincipal): Promise<boolean> {
    try {
      const bound = await this.binding(principal)
      const row = (await this.ports.pool.query<{ run_id: string; node_id: string }>(
        'select run_id,workflow_node_id as node_id from harness_executions where id=$1', [bound.execution_id])).rows[0]
      return !!row && workflowArtifactsAreLocal(this.ports.pool, row.run_id, row.node_id)
    } catch (error) { if (error instanceof DomainError && error.status < 500) return false; throw error }
  }

  private async declaration(principal: ManagementPrincipal, operation: WorkerNativeOutputOperation,
    sql: FileQuery = this.ports.pool) {
    const bound = await this.binding(principal, sql)
    const artifacts = this.ports.artifacts()
    const current = await artifacts.authority.execution(sql, bound.execution_id)
    const harness = current.configuration.harness
    const role = current.configuration.productRole === 'orchestrator' ? 'orchestrator' : 'coder'
    const toolName = WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation]
    if (harness.harness !== 'opencode' || !openCodeWorkflowOutputAllowed(harness, operation)
      || !effectiveGraphqlTools(role, current.configuration.graphqlTools, current.node.graphqlTools)
        .some(tool => tool === toolName)) throw denied()
    await artifacts.authority.assertDeclarations(bound.execution_id, sql, operation)
    return { bound, current }
  }

  private async execute(principal: ManagementPrincipal, command: WorkerNativeOutputCommand, originalArgs: unknown) {
    const declaration = await this.declaration(principal, command.operation)
    const executionId = declaration.bound.execution_id
    const signal = AbortSignal.timeout(120_000)
    const native = await this.ports.nativeCall(executionId, WORKER_NATIVE_OUTPUT_TOOL_NAMES[command.operation], originalArgs, signal)
    const artifacts = this.ports.artifacts()
    let accepted: Awaited<ReturnType<LocalWorkflowArtifacts['authority']['context']>>
    for (;;) {
      try { accepted = await artifacts.authority.context(executionId, { mutation: true, operation: command.operation }); break }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'NATIVE_ARTIFACT_CONTEXT_PENDING') throw error
        native.assertCurrent()
        await this.declaration(principal, command.operation)
        await delay(25, undefined, { signal })
      }
    }
    if (native.descriptor.nativeSessionId !== accepted.caller.context.nativeSessionId
      || native.descriptor.rootTurnId !== accepted.caller.context.turnId
      || declaration.bound.native_session_id !== accepted.caller.context.nativeSessionId) throw denied()
    const authorize = async (sql: FileQuery) => {
      signal.throwIfAborted()
      native.assertCurrent()
      const latest = await this.declaration(principal, command.operation, sql)
      if (latest.bound.execution_id !== executionId || latest.bound.native_session_id !== native.descriptor.nativeSessionId) throw denied()
      const current = await artifacts.authority.context(executionId, { query: sql, mutation: true, operation: command.operation })
      if (current.caller.binding !== accepted.caller.binding) throw denied()
      await this.ports.authorizeNativeCall(sql, executionId, command, native)
      native.assertCurrent()
      signal.throwIfAborted()
    }
    for (;;) {
      try { await authorize(this.ports.pool); break }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'WORKFLOW_OUTPUT_APPROVAL_PENDING') throw error
        native.assertCurrent()
        await delay(25, undefined, { signal })
      }
    }
    const reply = await this.repository.dispatch({ mainId: artifacts.authority.mainId, executionId,
      binding: accepted.caller.binding, principalId: principal.id }, command, authorize,
    (publication, snapshot) => artifacts.publish(executionId, publication, snapshot, authorize), accepted.caller.context.scope)
    await authorize(this.ports.pool)
    return reply
  }

  async register(server: McpServer, _request: FastifyRequest, principal: ManagementPrincipal): Promise<void> {
    for (const operation of operations) {
      try { await this.declaration(principal, operation) }
      catch (error) { if (error instanceof DomainError && error.status < 500) continue; throw error }
      const schema = WorkerNativeOutputToolInputSchemas[operation]
      server.registerTool(WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation], { inputSchema: schema,
        outputSchema: WorkerNativeOutputReplySchema,
        description: `${operation} an original local workflow artifact using this authenticated native turn. No host path or caller scope. Requires the saved Agent tool enablement, native permissions and workflow owner write grant.`,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async raw => {
        try { return toolResult(await this.execute(principal,
          parseNativeOutputToolCommand(WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation], raw), raw)) }
        catch (error) {
          await this.auditDenied(principal, WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation], error)
          return toolFailure(error)
        }
      })
    }
  }

  async call(_request: FastifyRequest, principal: ManagementPrincipal, body: unknown): Promise<unknown | undefined> {
    const request = callSchema.safeParse(body)
    if (!request.success) return undefined
    const operation = operations.find(operation => WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation] === request.data.params.name)
    if (!operation) return undefined
    try {
      const command = parseNativeOutputToolCommand(request.data.params.name, request.data.params.arguments)
      if (command.operation !== operation) throw denied()
      return { jsonrpc: '2.0', id: request.data.id,
        result: toolResult(await this.execute(principal, command, request.data.params.arguments)) }
    } catch (error) {
      await this.auditDenied(principal, request.data.params.name, error)
      return { jsonrpc: '2.0', id: request.data.id, result: toolFailure(error) }
    }
  }

  async cleanupClosed(): Promise<void> {
    const rows = (await this.ports.pool.query<{ execution_id: string }>(`select distinct o.execution_id
      from local_workflow_native_outputs o join execution_native_closures c on c.execution_id=o.execution_id
      where o.retired_at is null and c.closed_at is not null
        and c.generation=(select max(generation) from execution_native_closures where execution_id=o.execution_id)
      order by o.execution_id limit 100`)).rows
    for (const row of rows) await this.repository.retire(row.execution_id)
  }
}
