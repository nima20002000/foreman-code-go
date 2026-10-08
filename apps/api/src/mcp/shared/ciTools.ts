import type { McpServer } from '@modelcontextprotocol/server'
import { CiRunInputSchema, OperatorCiRunInputSchema, CiRunOutputSchema,
  CiGetInputSchema, OperatorCiGetInputSchema, CiGetOutputSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../../modules/jobs/ciAuthority.js'
import type { CiService } from '../../modules/jobs/ci.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from './results.js'

export const CI_CAPABILITY_DETAIL = 'ci_run captures all tracked files at the requested commit or Main project HEAD, '
  + 'reuses a workspace/suite Auto verification definition and queues build capacity. Retrying commandId returns the original ticket. '
  + 'ci_get returns queue reasons, selected computer, process, publication, digest-verified summary and a 32 KiB log tail. '
  + 'Agents are restricted to their active Run workspace and its accepted grants. Qualification matches dependency inputs; '
  + 'changed dependencies trigger persisted runtime preparation from the queue on enabled build computers. '
  + 'Preparation requires the original caller’s job_artifacts:read and profile/source write grants; no grants are added. '
  + 'The original ticket resolves its image from a reviewed qualified profile and retains its other policy and resource limits. '
  + 'No CI approval step is required.'
type CiTool = 'ci_run' | 'ci_get'
interface CiContext {
  principal: ManagementPrincipal
  services: { ci?: CiService; commands: PostgresCommandCoordinator }
}
const actions = { ci_run: CI_RUN_ACTIONS, ci_get: CI_GET_ACTIONS }
export function ciCapabilities(context: CiContext, resource: AuthorizedResource) {
  if (!context.services.ci) return []
  return (['ci_run', 'ci_get'] as const).filter(name => actions[name].every(action =>
    Object.keys(resource).length ? isAuthorized(context.principal, action, resource) : hasAction(context.principal, action)))
    .map(name => ({ name, actions: actions[name], detail: CI_CAPABILITY_DETAIL }))
}

export function registerCiTools(server: McpServer, context: CiContext) {
  const ci = context.services.ci
  if (!ci) return
  const operator = context.principal.audience === 'operator'
  const available = (name: CiTool) => !operator || ciCapabilities(context, {}).some(tool => tool.name === name)
  const invoke = async (name: CiTool, work: () => Promise<unknown>) => {
    try { return toolResult(await work()) }
    catch (error) {
      if (error instanceof DomainError && [401, 403, 404].includes(error.status)) {
        await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
      } else {
        await context.services.commands.recordAudit(context.principal.id, 'mcp', name, `mcp:${name}`, 'failed', {
          code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
        })
      }
      return toolFailure(error)
    }
  }
  if (available('ci_run')) server.registerTool('ci_run', {
    description: CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiRunInputSchema : CiRunInputSchema,
    outputSchema: CiRunOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, input => invoke('ci_run', () => ci.run(context.principal, input)))
  if (available('ci_get')) server.registerTool('ci_get', {
    description: CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiGetInputSchema : CiGetInputSchema,
    outputSchema: CiGetOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke('ci_get', () => ci.get(context.principal, input)))
}
