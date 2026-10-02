import type pg from 'pg'
import type { DeviceConnectionIdentity } from '@graphql/contracts/device-identity'
import { WorkerMcpRelayRequestSchema, WorkerMcpRelayAuthorizationSchema, WorkerMcpRelayResponseSchema, WorkerNativeOutputAuthorizationSchema, type WorkerMcpRelayRequest } from '@graphql/contracts/worker-mcp-relay'
import { WORKER_NATIVE_OUTPUT_FILE_OPERATIONS } from '@graphql/contracts/worker-native-output'
import type { PostgresArtifactPublicationAuthority } from '../runs/remote/nativeArtifactAuthority.js'
import type { AcceptedArtifactPublication } from '../files/distributed/publication.js'
import type { FileQuery } from '../files/repository.js'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import type { PostgresAccessService } from '../access/postgres.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { requireAuthorization } from '../access/policy.js'
import { workerScopesForAction } from '../access/appPolicy.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readAcceptedPlacement } from './persistence.js'
import { DomainError } from '../errors.js'

export interface SelectedMainMcpForward {
  /** Existing selected main's MCP transports, with this exact worker bearer;
   * never browser cookies, Operator secrets or another worker's loopback app. */
  request(body: unknown, token: string, protocolVersion?: string): Promise<{ statusCode: number; contentType: 'application/json' | 'text/event-stream' | 'empty'; body: string }>
}
export type NativeOutputRequest = Extract<WorkerMcpRelayRequest, { operation: 'worker-mcp.authorize-native-output' }>
export interface WorkerNativeOutputAuthorizationPort {
  /** Must use the actual original admitted publication context, never tool scope or a replacement lease. */
  authorize(input: NativeOutputRequest, connection: DeviceConnectionIdentity, sql: FileQuery): Promise<void>
}
export function createWorkerNativeOutputAuthorizationPort(
  authority: Pick<PostgresArtifactPublicationAuthority, 'authorize'>,
  resolveAccepted: (input: NativeOutputRequest, connection: DeviceConnectionIdentity, sql: FileQuery) => Promise<AcceptedArtifactPublication>,
): WorkerNativeOutputAuthorizationPort {
  return { async authorize(input, connection, sql) {
    const accepted = await resolveAccepted(input, connection, sql)
    const caller = await authority.authorize(accepted, sql)
    const scope = caller.context.scope.chat
    if (scope.kind !== 'agent' || scope.runId !== input.intent.runId || scope.executionId !== input.intent.executionId
      || scope.agentId !== input.applicationAccess.agentId || accepted.attempt.executionId !== input.intent.executionId
      || accepted.attempt.runId !== input.intent.runId || accepted.attempt.nodeId !== input.intent.nodeId
      || accepted.attempt.attemptId !== input.intent.attemptId || accepted.attempt.placementHash !== input.intent.bindingHash
      || caller.context.nativeSessionId !== input.nativeSessionId || caller.context.turnId !== input.turnId
      || !caller.context.allowMutation || !caller.context.allowedTools.includes(WORKER_NATIVE_OUTPUT_FILE_OPERATIONS[input.outputOperation])) {
      throw new DomainError('WORKER_NATIVE_OUTPUT_DENIED', 'The original native file operation is not authorized.', 403)
    }
    requireAuthorization(caller.principal, 'agent_chat:write', {
      workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
    })
  } }
}
/** Main-only domain handler on W07's authenticated worker-mcp-v1 namespace. It
 * validates the original execution lease before the existing MCP transport
 * repeats normal role/tool/scope authorization. No new credential is minted. */
export class MainWorkerMcpRelay {
  constructor(private readonly mainId: string, private readonly pool: pg.Pool,
    private readonly access: Pick<PostgresAccessService, 'authenticate'>, private readonly forward: SelectedMainMcpForward,
    private readonly nativeOutputs?: WorkerNativeOutputAuthorizationPort) {}
  async handle(raw: unknown, connection: DeviceConnectionIdentity) {
    const input = WorkerMcpRelayRequestSchema.parse(raw), app = input.applicationAccess
    const principal = await this.access.authenticate(app.token, 'worker')
    if (principal.audience !== 'worker' || principal.agentId !== app.agentId || input.placement.payload.kind !== 'agent'
      || input.placement.payload.agentId !== app.agentId || input.intent.executionId !== app.executionId
      || input.intent.operationId !== app.operationId || input.intent.attemptId !== app.attemptId
      || input.intent.bindingHash !== app.bindingHash || input.placement.bindingHash !== app.bindingHash
      || input.intent.mainId !== this.mainId || connection.mainId !== this.mainId) {
      throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'Application access must match the original execution lease.', 403)
    }
    const client = await this.pool.connect()
    let authorization: ReturnType<typeof WorkerMcpRelayAuthorizationSchema.parse>
    try {
      await client.query('begin')
      const intent = await readReconciledDispatchIntent(client, app.operationId, true)
      const placement = await readAcceptedPlacement(client, input.intent.runId, input.intent.nodeId)
      if (!intent || !placement || !sameWorkflowValue(intent, input.intent) || !sameWorkflowValue(placement, input.placement)
        || placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== connection.deviceId) {
        throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'The MCP caller is outside the accepted dispatch.', 403)
      }
      const registration = await assertDeviceHostInstallation(client, placement.hostRef, connection.workerInstallationId)
      if (!registration || !placement.registration || registration.keyRevision !== connection.keyRevision
        || registration.authorizationRevision !== connection.authorizationRevision
        || registration.keyRevision !== placement.registration.keyRevision || registration.authorizationRevision !== placement.registration.authorizationRevision) {
        throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'The execution device grant changed.', 403)
      }
      const rows = await client.query<{ execution_id: string; run_id: string; workspace_id: string; workflow_id: string; agent_id: string; purpose: string; revoked_at: Date | null;
        execution_state: string; run_state: string; authorization_principal_id: string; stopped: boolean; cleanup: boolean }>(`select b.execution_id,b.run_id,b.workspace_id,b.workflow_id,b.agent_id,b.purpose,b.revoked_at,
        he.record->>'state' as execution_state,r.execution_state as run_state,r.record->>'authorizationPrincipalId' as authorization_principal_id,
        r.stop_requested_at is not null as stopped,
        exists(select 1 from run_cleanup_intents i where i.run_id=r.id and i.pending) as cleanup
        from worker_credential_bindings b join harness_executions he on he.id=b.execution_id join runs r on r.id=b.run_id
        where b.principal_id=$1 and b.execution_id=$2 for share of b,he,r`, [principal.id, app.executionId])
      const binding = rows.rows[0]
      if (rows.rows.length !== 1 || !binding || binding.revoked_at || binding.execution_id !== app.executionId || binding.run_id !== intent.runId
        || binding.agent_id !== app.agentId || binding.stopped || binding.cleanup || !['running', 'waiting'].includes(binding.run_state)
        || (binding.purpose === 'workflow' ? !['starting', 'running', 'waiting'].includes(binding.execution_state)
          : binding.purpose !== 'reviewer' || binding.execution_state !== 'completed')) {
        throw new DomainError('WORKER_MCP_LEASE_UNAVAILABLE', 'The original application lease no longer permits native tool access.', 403)
      }
      if (!workerScopesForAction(principal, 'interactions:read').some(scope => scope.workspaceIds?.includes(binding.workspace_id)
        && scope.workflowIds?.includes(binding.workflow_id) && scope.runIds?.includes(binding.run_id))) {
        throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'The worker grant must cover the complete original execution scope.', 403)
      }
      const authority = await currentOperatorAuthority(client, binding.authorization_principal_id)
      requireAuthorization(authority.principal, 'runs:start', { workspaceId: binding.workspace_id, workflowId: binding.workflow_id })
      authorization = WorkerMcpRelayAuthorizationSchema.parse({ version: 1, mainId: this.mainId, audience: 'worker', principalId: principal.id,
        executionId: app.executionId, agentId: app.agentId, operationId: app.operationId, attemptId: app.attemptId, bindingHash: app.bindingHash, expiresAt: principal.expiresAt })
      if (input.operation === 'worker-mcp.authorize-native-output') {
        if (binding.purpose !== 'workflow' || placement.payload.kind !== 'agent' || !placement.payload.artifactOutputs) {
          throw new DomainError('WORKER_NATIVE_OUTPUT_DENIED', 'Native output requires the original declared workflow Agent.', 403)
        }
        if (!this.nativeOutputs) throw new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE', 'Native output authorization is not mounted.', 409)
        await this.nativeOutputs.authorize(input, connection, client)
      }
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    if (input.operation === 'worker-mcp.authorize') return authorization
    if (input.operation === 'worker-mcp.authorize-native-output') return WorkerNativeOutputAuthorizationSchema.parse({
      ...authorization, outputOperation: input.outputOperation, nativeSessionId: input.nativeSessionId, turnId: input.turnId,
    })
    return WorkerMcpRelayResponseSchema.parse(await this.forward.request(input.body, app.token, input.protocolVersion))
  }
}

const artifactToolPaths = new Map([
  ['files.admit_transferred_result', '/mcp/artifact-transfers'],
  ['files.publish_transferred_result', '/mcp/artifact-publications'],
  ['files.read_edge_input', '/mcp/artifact-inputs'],
])

/** Uses the existing selected main app instance and authentication path. It
 * exposes no new listener and never forwards cookies or an Operator bearer. */
export function selectedMainMcpForward(app: import('fastify').FastifyInstance): SelectedMainMcpForward {
  return { async request(body, token, protocolVersion) {
    const request = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown> : undefined
    const url = request?.method === 'tools/call' && typeof params?.name === 'string'
      ? artifactToolPaths.get(params.name) ?? '/mcp' : '/mcp'
    const response = await app.inject({ method: 'POST', url, payload: body as Record<string, unknown>, headers: {
      host: '127.0.0.1', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    } })
    const type = response.headers['content-type']
    const contentType = response.payload === '' ? 'empty' : typeof type === 'string' && type.startsWith('application/json') ? 'application/json'
      : typeof type === 'string' && type.startsWith('text/event-stream') ? 'text/event-stream' : undefined
    if (!contentType) throw new DomainError('WORKER_MCP_RESPONSE_INVALID', 'The selected main returned an unsupported MCP response.', 502)
    return { statusCode: response.statusCode, contentType, body: response.payload }
  } }
}
