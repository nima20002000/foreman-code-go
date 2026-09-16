import type pg from 'pg'
import type { OperatorConfigurationVersion } from '@graphql/contracts'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresAccessService } from '../access/postgres.js'
import { CodexAppServerSessionManager } from '../harnesses/codexAppServer.js'
import { OpenCodeNativeSessionManager } from '../harnesses/opencodeServer.js'
import type { NativeRollout } from '../harnesses/nativeRollout.js'
import type { ChildProcessEnvironment, NativeHarnessSessionManager } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { OperatorChatAuthority } from './operatorChat.js'

export const OPERATOR_MCP_ENVIRONMENT_VARIABLE = 'GRAPHQL_OPERATOR_MCP_TOKEN'

export class PostgresOperatorChatAuthority implements OperatorChatAuthority {
  private readonly credentials = new Map<string, { environment: ChildProcessEnvironment; ownerId: string }>()
  constructor(private readonly pool: pg.Pool, private readonly access: PostgresAccessService,
    private readonly rollout: NativeRollout, private readonly directory: string, private readonly endpoint: string) {}

  current(principalId: string) { return this.access.currentOperator(principalId) }
  assertConfiguration(configuration: OperatorConfigurationVersion) { this.rollout.assertChat(configuration) }

  async prepare(manager: NativeHarnessSessionManager, configuration: OperatorConfigurationVersion, conversationId: string,
    principalId: string, signal: AbortSignal): Promise<ChildProcessEnvironment> {
    const principal = await this.current(principalId)
    requireAuthorization(principal, 'operator_chat:write')
    const cached = this.credentials.get(conversationId)
    if (cached) {
      if (cached.ownerId !== principalId) throw new DomainError('ACCESS_DENIED', 'A native credential cannot change owners.', 403)
      return cached.environment
    }
    this.assertConfiguration(configuration)
    if (manager instanceof CodexAppServerSessionManager) {
      const inspected = await manager.inspectMcpConfiguration(this.directory, signal)
      if (inspected.serverName !== 'graphql-operator' || !inspected.configured.enabled
        || inspected.configured.url !== this.endpoint || inspected.configured.transport !== 'streamable_http'
        || inspected.configured.bearerTokenEnvironmentVariable !== OPERATOR_MCP_ENVIRONMENT_VARIABLE) this.invalidSetup()
    } else if (manager instanceof OpenCodeNativeSessionManager) {
      const inspected = await manager.inspectNativeMcp(this.directory, signal)
      if (inspected.serverName !== 'graphql-operator' || inspected.endpoint !== this.endpoint
        || ['not_detected', 'disabled'].includes(inspected.nativeStatus)
        || inspected.credentialEnvironmentVariable !== OPERATOR_MCP_ENVIRONMENT_VARIABLE) this.invalidSetup()
    } else this.invalidSetup()
    signal.throwIfAborted()
    const grants = principal.grants.map((grant) => ({ ...grant, actions: grant.actions.filter((action) => !action.startsWith('operator_chat:')) }))
      .filter((grant) => grant.actions.length > 0)
    if (!grants.length) throw new DomainError('ACCESS_DENIED', 'This principal has no management authority to delegate to the Operator.', 403)
    const issued = await this.access.issue({ name: `operator-chat:${conversationId}`, audience: 'operator', grants,
      expiresAt: new Date(principal.expiresAt) })
    try {
      // The token is not returned to a native process until both ownership records exist.
      await this.pool.query('update management_principals set delegated_from=$2 where id=$1', [issued.principal.id, principal.id])
      await this.pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)', [issued.principal.id, conversationId])
      signal.throwIfAborted()
      const environment = { agentId: configuration.operatorId, variables: { [OPERATOR_MCP_ENVIRONMENT_VARIABLE]: issued.token } }
      this.credentials.set(conversationId, { environment, ownerId: principal.id })
      return environment
    } catch (error) { await this.access.revoke(issued.principal.id).catch(() => undefined); throw error }
  }
  private invalidSetup(): never {
    throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Configure graphql-operator at the accepted /mcp/operator endpoint using GRAPHQL_OPERATOR_MCP_TOKEN. Native configuration was not rewritten.', 409)
  }
  async release(conversationId: string): Promise<void> {
    this.credentials.delete(conversationId)
    await this.pool.query(`update management_principals set revoked_at=coalesce(revoked_at,now())
      where id in (select principal_id from operator_chat_credentials where conversation_id=$1)`, [conversationId])
  }
  async revokeOrphanedCredentials(): Promise<void> {
    await this.pool.query(`update management_principals set revoked_at=coalesce(revoked_at,now())
      where id in (select principal_id from operator_chat_credentials)`)
  }
}
