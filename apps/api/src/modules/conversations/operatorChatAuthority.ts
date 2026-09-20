import type pg from 'pg'
import type { OperatorChatSetup, OperatorConfigurationVersion } from '@graphql/contracts'
import { requireAuthorization } from '../access/policy.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { operatorChatGrants } from '../access/operatorChatDelegation.js'
import { PostgresOperatorReviewLifecycle } from './operatorReviewLifecycle.js'
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

  async setup(manager: NativeHarnessSessionManager, signal: AbortSignal, configuration?: OperatorConfigurationVersion): Promise<OperatorChatSetup> {
    const result = { harness: manager.harness, endpoint: this.endpoint, checkedAt: new Date().toISOString() }
    if (configuration?.harness.harness === 'opencode'
      && configuration.harness.advanced?.mcp.serverEnabled['graphql-operator'] === false) {
      return { ...result, status: 'setup_required',
        reason: 'The selected Operator settings disable graphql-operator. Enable that connection in Operator advanced settings before sending a new message.' }
    }
    if (manager instanceof CodexAppServerSessionManager) {
      try {
        const inspected = await manager.inspectMcpConfiguration(this.directory, signal)
        const configured = inspected.serverName === 'graphql-operator' && inspected.configured.enabled
          && inspected.configured.url === this.endpoint && inspected.configured.transport === 'streamable_http'
          && inspected.configured.bearerTokenEnvironmentVariable === OPERATOR_MCP_ENVIRONMENT_VARIABLE
        return { ...result, status: configured ? 'configured' : 'setup_required' }
      } catch (error) {
        if (error && typeof error === 'object' && 'result' in error
          && (error.result as { error?: { code?: string } })?.error?.code === 'CODEX_MCP_NOT_CONFIGURED') {
          return { ...result, status: 'setup_required' }
        }
        throw error
      }
    }
    if (manager instanceof OpenCodeNativeSessionManager) {
      const inspected = await manager.inspectNativeMcp(this.directory, signal, 'configuration')
      const configured = inspected.serverName === 'graphql-operator' && inspected.endpoint === this.endpoint
        && inspected.transport === 'streamable-http' && !['not_detected', 'disabled'].includes(inspected.nativeStatus)
        && inspected.credentialEnvironmentVariable === OPERATOR_MCP_ENVIRONMENT_VARIABLE
      return { ...result, status: configured ? 'configured' : 'setup_required' }
    }
    this.invalidSetup()
  }

  async prepare(manager: NativeHarnessSessionManager, configuration: OperatorConfigurationVersion, conversationId: string,
    principalId: string, signal: AbortSignal): Promise<ChildProcessEnvironment> {
    const principal = await this.current(principalId)
    requireAuthorization(principal, 'operator_chat:write')
    const reviews = new PostgresOperatorReviewLifecycle(this.pool)
    await reviews.assertActive(conversationId)
    signal.throwIfAborted()
    if ((await this.setup(manager, signal, configuration)).status !== 'configured') this.invalidSetup()
    const cached = this.credentials.get(conversationId)
    if (cached) {
      if (cached.ownerId !== principalId) throw new DomainError('ACCESS_DENIED', 'A native credential cannot change owners.', 403)
      return cached.environment
    }
    this.assertConfiguration(configuration)
    signal.throwIfAborted()
    const client = await this.pool.connect()
    let issued: Awaited<ReturnType<PostgresAccessService['issue']>> | undefined
    try {
      await client.query('begin')
      // Same ordering as Run review shutdown: parent authority, then conversation.
      await client.query('select id from management_principals where id=$1 for share', [principalId])
      const owner = (await currentOperatorAuthority(client, principalId)).principal
      requireAuthorization(owner, 'operator_chat:write')
      const conversation = await client.query(`select id from operator_conversations
        where id=$1 and owner_principal_id=$2 and record->>'status'='open' for share`, [conversationId, principalId])
      if (conversation.rowCount !== 1) throw new DomainError('OPERATOR_REVIEW_ENDED', 'The conversation is no longer open.', 409)
      await reviews.assertActive(conversationId, client)
      signal.throwIfAborted()
      const grants = operatorChatGrants(owner.grants)
      if (!grants.length) throw new DomainError('ACCESS_DENIED', 'This principal has no management authority to delegate to the Operator.', 403)
      issued = await this.access.issue({ name: `operator-chat:${conversationId}`, audience: 'operator', grants,
        expiresAt: new Date(owner.expiresAt) }, client)
      // Issuance and both bindings commit together. End/release cannot miss a late credential.
      await client.query('update management_principals set delegated_from=$2 where id=$1', [issued.principal.id, owner.id])
      await client.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)', [issued.principal.id, conversationId])
      signal.throwIfAborted()
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
    try {
      signal.throwIfAborted()
      const environment = { agentId: configuration.operatorId, variables: { [OPERATOR_MCP_ENVIRONMENT_VARIABLE]: issued.token } }
      this.credentials.set(conversationId, { environment, ownerId: principalId })
      return environment
    } catch (error) {
      await this.access.revoke(issued.principal.id)
      throw error
    }
  }
  private invalidSetup(): never {
    throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Install and enable the graphql-operator MCP connection in the selected harness before chatting. Use the app endpoint and GRAPHQL_OPERATOR_MCP_TOKEN environment reference.', 409)
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
