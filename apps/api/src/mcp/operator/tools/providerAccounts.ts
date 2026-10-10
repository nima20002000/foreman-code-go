import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  PROVIDER_ACCOUNT_TOOLS, ProviderAccountCreateInputSchema, ProviderAccountsSnapshotSchema,
  ProviderAccountToolCommandSchema, ProviderAccountToolRenameSchema, ProviderAccountUpdateResultSchema,
} from '@foreman-code/contracts/provider-accounts'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import { toolFailure } from '../../shared/results.js'
import { DomainError } from '../../../modules/errors.js'

export function registerProviderAccountTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.providerAccounts
  if (!service) return
  if (operatorToolAvailable(context, 'provider_accounts_list')) server.registerTool('provider_accounts_list', {
    description: 'Read this computer’s named Codex/ChatGPT and Claude accounts, provider defaults, sign-in '
      + 'status and snapshot revision. Credentials and local paths are never returned. Requires global settings:read. '
      + 'API-key provisioning is local-human-only through Settings; MCP never receives API keys.',
    inputSchema: z.object({}).strict(), outputSchema: ProviderAccountsSnapshotSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => invokeOperatorTool(context, 'provider_accounts_list', () => service.list(context.principal)))
  if (operatorToolAvailable(context, 'provider_account_create')) server.registerTool('provider_account_create', {
    description: 'Create a named host-local account with an isolated credential home. Codex uses subscription '
      + 'sign-in; Claude supports subscription or api-key. The first account becomes its provider’s default. '
      + 'Use the snapshot expectedRevision and retry the same commandId/input after an uncertain response. '
      + 'Requires global settings:read and settings:update. API keys are provisioned only by a local human in Settings.',
    inputSchema: ProviderAccountCreateInputSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'provider_account_create', () => service.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'provider_account_rename')) server.registerTool('provider_account_rename', {
    description: 'Rename a local provider account. expectedRevision is the accounts snapshot revision. '
      + 'Requires global settings:read and settings:update; retry identical commandId and input.',
    inputSchema: ProviderAccountToolRenameSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ accountId, ...input }) => invokeOperatorTool(context, 'provider_account_rename',
    () => service.rename(context.principal, 'mcp', accountId, input)))
  const commands = [
    ['provider_account_default_set', 'setDefault', 'Choose the default account for newly started provider sessions.'],
    ['provider_account_login', 'login', 'Start the provider’s own subscription sign-in command. It opens the local browser; a human completes authorization. Read status afterward.'],
    ['provider_account_logout', 'logout', 'Sign out only this managed account. Existing sessions retain their accepted account selection.'],
    ['provider_account_refresh', 'refresh', 'Refresh and persist this account’s status through the provider’s own local status command.'],
  ] as const
  for (const [name, method, description] of commands) {
    if (!operatorToolAvailable(context, name)) continue
    server.registerTool(name, {
      description: description + ' Requires global settings:read and settings:update. expectedRevision is the '
        + 'accounts snapshot revision; retry the same commandId and input. Credentials stay on this computer.',
      inputSchema: ProviderAccountToolCommandSchema, outputSchema: ProviderAccountUpdateResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: method === 'logout', idempotentHint: true,
        openWorldHint: method === 'login' },
    }, ({ accountId, ...input }) => invokeOperatorTool(context, name,
      () => service[method](context.principal, 'mcp', accountId, input)))
  }
}

export async function unavailableProviderAccountToolCall(context: OperatorRequestContext, body: unknown) {
  const request = body as { id?: unknown; method?: unknown; params?: { name?: unknown } }
  if (request?.method !== 'tools/call' || typeof request.params?.name !== 'string') return undefined
  const name = PROVIDER_ACCOUNT_TOOLS.find(tool => tool === request.params!.name)
  if (!name || operatorToolAvailable(context, name)) return undefined
  await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: request.id,
    result: toolFailure(new DomainError('ACCESS_DENIED', 'The caller is not authorized for this account operation.', 403)) }
}
