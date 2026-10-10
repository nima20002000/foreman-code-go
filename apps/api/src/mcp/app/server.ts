import { MCP_DISPLAY_NAME, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { invokeAppTool } from './invoke.js'
import {
  AppContextSchema,
  InteractionGetInputSchema,
  InteractionGetOutputSchema,
  AppInteractionListInputSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
} from './schemas.js'
import type { AppRequestContext } from './types.js'
import { hasWorkerAction } from '../../modules/access/appPolicy.js'
import { registerBugReportTool } from '../shared/bugReports.js'

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

export async function createAppMcpServer(context: AppRequestContext): Promise<McpServer> {
  const server = new McpServer({ name: PRODUCT_SLUG, title: MCP_DISPLAY_NAME, version: '1.0.0' })
  await registerAppTools(server, context)
  return server
}

export async function registerAppTools(server: McpServer, context: AppRequestContext): Promise<void> {
  if (context.bugReports && hasWorkerAction(context.principal, 'bug_reports:report')) {
    registerBugReportTool(server, {
      principal: context.principal,
      service: context.bugReports,
      invoke: work => invokeAppTool(context, 'bug_report', work),
    })
  }
  server.registerTool('context_get', {
    description: 'Return this authenticated Foreman Code Agent identity, role, immutable scope, and current App capabilities. Response capability requires a directly connected requester in the saved Run graph; every decision also checks the exact request, role and credential.',
    inputSchema: z.object({}).strict(),
    outputSchema: AppContextSchema,
    annotations: readAnnotations,
  }, async () => invokeAppTool(context, 'context_get', () => context.interactions.context(context.principal)))

  const canRead = await context.interactions.canRead(context.principal)
  if (canRead) server.registerTool('interaction_list', {
    description: 'List pending Foreman Code interactions visible to this authenticated Agent within a byte-bounded page. Follow nextCursor for more items; contentOmitted summaries include interaction_get retrieval instructions.',
    inputSchema: AppInteractionListInputSchema,
    outputSchema: ListInteractionsResponseSchema,
    annotations: readAnnotations,
  }, async (input) => invokeAppTool(context, 'interaction_list', () => context.interactions.list(context.principal, input)))

  if (canRead) server.registerTool('interaction_get', {
    description: 'Inspect one authorized Foreman Code interaction and its server-generated response options. Large results include content.text containing a JSON fragment; concatenate fragments while calling this tool with content.nextCursor as contentCursor until null. A changed-content error requires restarting the read. Omitted response options are included in the complete JSON.',
    inputSchema: InteractionGetInputSchema,
    outputSchema: InteractionGetOutputSchema,
    annotations: readAnnotations,
  }, async (input) => invokeAppTool(context, 'interaction_get', () => context.interactions.get(
    context.principal, input.interactionId, input.contentCursor,
  )))

  if (await context.interactions.canRespond(context.principal)) {
    server.registerTool('interaction_respond', {
      description: 'Respond using a server-generated option only as the designated Orchestrator directly connected to the exact requesting node in the Run’s immutable workflow version. A transitive path or shared Agent ID is insufficient. Your own native automatic review only authorizes this App MCP call; it does not decide the Worker request. Cancellation stops an uncommitted decision. After commit, read interaction_get to confirm the recorded decision and delivery state.',
      inputSchema: RespondToInteractionRequestSchema,
      outputSchema: RespondToInteractionResponseSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }, async (input) => invokeAppTool(context, 'interaction_respond', () => context.interactions.respond(
      context.principal, input, { signal: context.signal },
    )))
  }
}
