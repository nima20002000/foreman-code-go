import type { McpServer } from '@modelcontextprotocol/server'
import { CiRunInputSchema, OperatorCiRunInputSchema, CiRunOutputSchema,
  CiGetInputSchema, OperatorCiGetInputSchema, CiGetOutputSchema,
  CiCancelInputSchema, OperatorCiCancelInputSchema, CiCancelOutputSchema,
  CiLogsInputSchema, OperatorCiLogsInputSchema, CiLogsOutputSchema,
  CiArtifactsOutputSchema, CiArtifactInputSchema, OperatorCiArtifactInputSchema, CiArtifactOutputSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import { JobAuthoringChoicesRecordSchema } from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal, ManagementAction } from '@foreman-code/contracts/management'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../../modules/jobs/ciAuthority.js'
import type { CiService } from '../../modules/jobs/ci.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from './results.js'

export const CI_CAPABILITY_DETAIL = 'ci_run captures tracked files at the requested commit, the Agent’s accepted worktree, or Main project HEAD, '
  + 'reuses a workspace/suite Auto verification definition and queues build capacity. Retrying commandId returns the original ticket. '
  + 'ci_get returns queue reasons, selected computer, process, publication, digest-verified summary and a 32 KiB log tail. '
  + 'Agent-triggered tickets retain initiatingAgent (workflow, Run, Agent and execution), separate from graph job membership. '
  + 'Agents are restricted to their active Run workspace and its accepted grants. Qualification matches dependency inputs; '
  + 'changed dependencies trigger persisted runtime preparation from the queue on enabled build computers. '
  + 'Preparation requires the original caller’s job_artifacts:read and profile/source write grants; no grants are added. '
  + 'The original ticket resolves its image from a reviewed qualified profile and retains its other policy and resource limits. '
  + 'placementOverride selects Auto, a preferred computer with fallback, or an explicit computer/root from ci_computers_list. '
  + 'Poll ci_get by ticketId until process and publication finish; read complete logs with ci_logs_read and '
  + 'published revisions with ci_artifacts_list and ci_artifact_read. Cancel with ci_cancel using the queue revision. '
  + 'No CI approval step is required.'
export const CI_TOOLS = ['ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read',
  'ci_artifacts_list', 'ci_artifact_read'] as const
type CiTool = typeof CI_TOOLS[number]
interface CiContext {
  principal: ManagementPrincipal
  services: { ci?: CiService; commands: PostgresCommandCoordinator }
}
const actions: Record<CiTool, ManagementAction[]> = {
  ci_run: CI_RUN_ACTIONS,
  ci_get: CI_GET_ACTIONS,
  ci_computers_list: ['job_definitions:read', 'sources:read', 'source_roots:read'],
  ci_cancel: ['jobs:cancel'],
  ci_logs_read: ['jobs:read', 'job_logs:read'],
  ci_artifacts_list: ['jobs:read', 'job_artifacts:read'],
  ci_artifact_read: ['jobs:read', 'job_artifacts:read'],
}
export function ciCapabilities(context: CiContext, resource: AuthorizedResource) {
  if (!context.services.ci) return []
  return CI_TOOLS.filter(name => actions[name].every(action =>
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
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
  if (available('ci_computers_list')) server.registerTool('ci_computers_list', {
    description: 'Read authorized build computer/root choices, Auto resource envelopes and verification templates. '
      + 'Pass a target to ci_run placementOverride.kind=explicit or its hostRef to kind=prefer. '
      + 'Readiness and capacity are rechecked at launch. ' + CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiGetInputSchema.pick({ workspaceId: true }) : z.object({}).strict(),
    outputSchema: JobAuthoringChoicesRecordSchema, annotations: read,
  }, input => invoke('ci_computers_list', () => ci.computers(context.principal, input)))
  if (available('ci_cancel')) server.registerTool('ci_cancel', {
    description: 'Cancel a waiting, claimed or accepted CI ticket with expectedRevision from ci_get.queue. '
      + 'Retry the same commandId and payload after unknown acknowledgment. Requires jobs:cancel; '
      + 'poll ci_get to confirm process closure and cleanup before assuming capacity is released.',
    inputSchema: operator ? OperatorCiCancelInputSchema : CiCancelInputSchema,
    outputSchema: CiCancelOutputSchema,
    annotations: { ...read, readOnlyHint: false, destructiveHint: true },
  }, input => invoke('ci_cancel', () => ci.cancel(context.principal, input)))
  if (available('ci_logs_read')) server.registerTool('ci_logs_read', {
    description: 'Read sequenced log chunks of the execution accepted for ticketId. Resume with nextCursor; '
      + 'truncation is explicit. Waiting tickets return CI_NOT_ACCEPTED. Requires jobs:read and job_logs:read.',
    inputSchema: operator ? OperatorCiLogsInputSchema : CiLogsInputSchema,
    outputSchema: CiLogsOutputSchema, annotations: read,
  }, input => invoke('ci_logs_read', () => ci.logs(context.principal, input)))
  if (available('ci_artifacts_list')) server.registerTool('ci_artifacts_list', {
    description: 'List the accepted CI execution’s artifact file/revision IDs, digests, sizes and expiry. '
      + 'Requires jobs:read and job_artifacts:read. Waiting tickets return CI_NOT_ACCEPTED.',
    inputSchema: operator ? OperatorCiGetInputSchema : CiGetInputSchema,
    outputSchema: CiArtifactsOutputSchema, annotations: read,
  }, input => invoke('ci_artifacts_list', () => ci.artifacts(context.principal, input)))
  if (available('ci_artifact_read')) server.registerTool('ci_artifact_read', {
    description: 'Read digest-verified immutable CI artifact bytes in chunks up to 1 MiB as base64 by ticketId, fileId '
      + 'and revisionId from ci_artifacts_list. Keep these IDs and resume with nextOffset as offset until null. '
      + 'Missing, expired or corrupt revisions fail. '
      + 'Requires jobs:read and job_artifacts:read.',
    inputSchema: operator ? OperatorCiArtifactInputSchema : CiArtifactInputSchema,
    outputSchema: CiArtifactOutputSchema, annotations: read,
  }, input => invoke('ci_artifact_read', () => ci.artifact(context.principal, input)))
}
