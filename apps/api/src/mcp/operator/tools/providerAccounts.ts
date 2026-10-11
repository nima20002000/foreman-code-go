import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  PROVIDER_ACCOUNT_TOOLS, ProviderAccountCreateInputSchema, ProviderAccountsSnapshotSchema,
  ProviderAccountToolCommandSchema, ProviderAccountToolRenameSchema, ProviderAccountUpdateResultSchema,
  ProviderAccountListInputSchema, ProviderAccountPageSchema, ProviderAccountGetInputSchema, ProviderAccountSchema,
  ProviderAccountRegisterInputSchema, ProviderAccountAuthenticationPrepareInputSchema,
  ProviderAccountAuthenticationReadInputSchema, ProviderAccountAuthenticationCancelInputSchema,
  ProviderAccountAuthenticationOperationSchema, ProviderAccountAuthenticationResultSchema,
  ProviderAccountTargetsSchema, ProviderAccountDiscoveryInputSchema, ProviderAccountProfilesSchema,
  ProviderAccountEligibilitySchema, ProviderAccountAuthenticationListInputSchema, ProviderAccountAuthenticationPageSchema,
  ProviderAccountModelsInputSchema, ProviderAccountModelsSchema, ProviderAccountDefaultInputSchema,
} from '@foreman-code/contracts/provider-accounts'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import { toolFailure } from '../../shared/results.js'
import { DomainError } from '../../../modules/errors.js'

export function registerProviderAccountTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.providerAccounts
  if (!service) return
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const writeAnnotations = { ...readAnnotations, readOnlyHint: false }
  if (operatorToolAvailable(context, 'provider_accounts_page')) server.registerTool('provider_accounts_page', {
    description: 'Read a target-identified cursor page with fresh ordered observations and independently revisioned defaults. Requires provider_accounts:read on the target.',
    inputSchema: ProviderAccountListInputSchema, outputSchema: ProviderAccountPageSchema, annotations: readAnnotations,
  }, input => invokeOperatorTool(context, 'provider_accounts_page', () => service.page(context.principal, input)))
  if (operatorToolAvailable(context, 'provider_account_get')) server.registerTool('provider_account_get', {
    description: 'Read the persisted binding/removal state and a fresh selected-slot observation without changing metadata revisions. Requires provider_accounts:read on the target/account.',
    inputSchema: ProviderAccountGetInputSchema, outputSchema: ProviderAccountSchema, annotations: readAnnotations,
  }, input => invokeOperatorTool(context, 'provider_account_get', () => service.get(context.principal, input)))
  const reads = [
    ['provider_account_targets', 'Read canonical Main/Worker targets, current generations, qualified actions and caller eligibility. Human handoff is HTTP-only.',
      z.object({}).strict(), ProviderAccountTargetsSchema, () => service.targets(context.principal)],
    ['provider_account_profiles', 'Read qualified existing profile choices by opaque reference. No arbitrary paths or credentials.',
      ProviderAccountDiscoveryInputSchema, ProviderAccountProfilesSchema,
      (input: unknown) => service.profiles(context.principal, input)],
    ['provider_account_eligibility', 'Read live manage and reauthentication limits for a slot, including saved uses and pending operations.',
      ProviderAccountGetInputSchema, ProviderAccountEligibilitySchema,
      (input: unknown) => service.eligibility(context.principal, input)],
    ['provider_account_auth_list', 'Discover persisted original authentication operations for one account after reconnect. Does not start or retry login.',
      ProviderAccountAuthenticationListInputSchema, ProviderAccountAuthenticationPageSchema,
      (input: unknown) => service.authenticationList(context.principal, input)],
  ] as const
  for (const [name, description, inputSchema, outputSchema, read] of reads) {
    if (!operatorToolAvailable(context, name)) continue
    server.registerTool(name, { description: description + ' Requires target-specific provider_accounts:read.',
      inputSchema, outputSchema, annotations: readAnnotations },
    (input: unknown) => invokeOperatorTool(context, name, () => read(input)))
  }
  if (operatorToolAvailable(context, 'provider_account_register')) server.registerTool('provider_account_register', {
    description: 'Register an explicitly selected qualified native profile by opaque reference. No paths or credentials. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountRegisterInputSchema, outputSchema: ProviderAccountUpdateResultSchema, annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'provider_account_register', () => service.register(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'provider_account_remove')) server.registerTool('provider_account_remove', {
    description: 'Remove an account from selection and clear its scoped default. Retains saved bindings and native history. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountToolCommandSchema, outputSchema: ProviderAccountUpdateResultSchema, annotations: writeAnnotations,
  }, ({ accountId, ...input }) => invokeOperatorTool(context, 'provider_account_remove',
    () => service.remove(context.principal, 'mcp', accountId, input)))
  if (operatorToolAvailable(context, 'provider_account_auth_prepare')) server.registerTool('provider_account_auth_prepare', {
    description: 'Reserve an authentication intent before native dispatch. A human completes provider authorization. Reuse the original command after an unknown response. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountAuthenticationPrepareInputSchema.extend({ accountId: ProviderAccountGetInputSchema.shape.accountId }),
    outputSchema: ProviderAccountAuthenticationResultSchema, annotations: writeAnnotations,
  }, ({ accountId, ...input }) => invokeOperatorTool(context, 'provider_account_auth_prepare',
    () => service.prepareAuthentication(context.principal, 'mcp', accountId, input)))
  if (operatorToolAvailable(context, 'provider_account_auth_status')) server.registerTool('provider_account_auth_status', {
    description: 'Reconcile the original authentication operation without starting another login. Returns sanitized lifecycle/closure only. Requires provider_accounts:read.',
    inputSchema: ProviderAccountAuthenticationReadInputSchema, outputSchema: ProviderAccountAuthenticationOperationSchema,
    annotations: readAnnotations,
  }, input => invokeOperatorTool(context, 'provider_account_auth_status',
    () => service.authenticationStatus(context.principal, input, 'mcp')))
  if (operatorToolAvailable(context, 'provider_account_auth_cancel')) server.registerTool('provider_account_auth_cancel', {
    description: 'Request cancellation of the original operation. Canceled means positive native closure; otherwise outcome remains unknown. expectedRevision is the operation revision. Requires provider_accounts:read/manage.',
    inputSchema: ProviderAccountAuthenticationCancelInputSchema, outputSchema: ProviderAccountAuthenticationResultSchema,
    annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'provider_account_auth_cancel', () => service.cancelAuthentication(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'provider_account_models')) server.registerTool('provider_account_models', {
    description: 'Observe full native model metadata for this account/profile/installation: reasoning, variants, service tiers and catalog provenance. Discovery does not qualify execution. No model prompt or fallback. Requires provider_accounts:read.',
    inputSchema: ProviderAccountModelsInputSchema, outputSchema: ProviderAccountModelsSchema, annotations: readAnnotations,
  }, input => invokeOperatorTool(context, 'provider_account_models', () => service.models(context.principal, input)))
  if (operatorToolAvailable(context, 'provider_accounts_list')) server.registerTool('provider_accounts_list', {
    description: 'Read this computer’s named Codex/ChatGPT and Claude accounts, provider defaults, sign-in '
      + 'status and snapshot revision. Credentials and local paths are never returned. Requires target-specific provider_accounts:read. '
      + 'API-key provisioning is local-human-only through Settings; MCP never receives API keys.',
    inputSchema: z.object({}).strict(), outputSchema: ProviderAccountsSnapshotSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => invokeOperatorTool(context, 'provider_accounts_list', () => service.list(context.principal)))
  if (operatorToolAvailable(context, 'provider_account_create')) server.registerTool('provider_account_create', {
    description: 'Create a named slot on the selected Main or qualified Worker; credentials remain with that native owner. Codex uses subscription '
      + 'sign-in; Claude supports subscription or api-key. The first account becomes its provider’s default. '
      + 'Use the snapshot expectedRevision and retry the same commandId/input after an uncertain response. '
      + 'Requires target-specific provider_accounts:read and provider_accounts:manage. API keys are provisioned only by a local human in Settings.',
    inputSchema: ProviderAccountCreateInputSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'provider_account_create', () => service.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'provider_account_rename')) server.registerTool('provider_account_rename', {
    description: 'Rename a local provider account. expectedRevision is the accounts snapshot revision. '
      + 'Requires target-specific provider_accounts:read and provider_accounts:manage; retry identical commandId and input.',
    inputSchema: ProviderAccountToolRenameSchema, outputSchema: ProviderAccountUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ accountId, ...input }) => invokeOperatorTool(context, 'provider_account_rename',
    () => service.rename(context.principal, 'mcp', accountId, input)))
  const commands = [
    ['provider_account_default_set', 'setDefault', 'Choose the default account for new work without a saved account/profile.'],
    ['provider_account_login', 'login', 'Prepare the original provider sign-in operation on the owning computer. A human completes browser authorization there. Rediscover the same operation with provider_account_auth_list after an unknown response.'],
    ['provider_account_logout', 'logout', 'Prepare sign-out for this managed account. Saved uses and unproved principal ownership prevent credential replacement; native history is retained.'],
    ['provider_account_refresh', 'refresh', 'Refresh and persist this account’s status through the provider’s own local status command.'],
  ] as const
  for (const [name, method, description] of commands) {
    if (!operatorToolAvailable(context, name)) continue
    server.registerTool(name, {
      description: description + ' Requires target-specific provider_accounts:read and provider_accounts:manage. expectedRevision is the '
        + 'accounts snapshot revision; retry the same commandId and input. Credentials stay on the owning computer.',
      inputSchema: method === 'setDefault'
        ? ProviderAccountDefaultInputSchema.extend({ accountId: ProviderAccountGetInputSchema.shape.accountId })
        : ProviderAccountToolCommandSchema, outputSchema: ProviderAccountUpdateResultSchema,
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
