import {
  AppInteractionGetInputSchema,
  AppInteractionGetOutputSchema,
  AppInteractionListOutputSchema,
  AppInteractionRespondOutputSchema,
  GraphqlAgentToolSchema,
  RespondToInteractionRequestSchema,
  IdSchema,
} from '@foreman-code/contracts'
import { z } from 'zod'
import { AppInteractionListInputSchema } from '../../modules/interactions/app.js'

export const AppContextSchema = z.object({
  principal: z.object({
    id: IdSchema,
    audience: z.literal('worker'),
    agentId: IdSchema,
    expiresAt: z.iso.datetime(),
  }).strict(),
  role: z.enum(['orchestrator', 'coder']),
  /** Foreman Code MCP tools enabled for this Agent's configuration and workflow node. */
  tools: z.array(GraphqlAgentToolSchema),
  scope: z.object({
    workspaceIds: z.array(IdSchema).optional(),
    workflowIds: z.array(IdSchema).optional(),
    runIds: z.array(IdSchema).optional(),
  }).strict(),
  capabilities: z.object({
    contextGet: z.literal(true),
    interactionList: z.boolean(),
    interactionGet: z.boolean(),
    interactionRespond: z.boolean(),
  }).strict(),
  /** This Agent's own git worktree and branch of the workspace repository, when the workspace has one. */
  worktree: z.object({ repository: z.string(), branch: z.string(), baseCommit: z.string(), path: z.string() }).strict().optional(),
  /** The workspace's shared Google Drive folder as mounted on this Agent's computer. Every Agent on a computer with Drive
   * connected sees the same files there; create it if missing. Writing needs the harness to allow that folder. */
  sharedFiles: z.object({ provider: z.literal('google-drive'), path: z.string() }).strict().optional(),
}).strict()

export const InteractionGetInputSchema = AppInteractionGetInputSchema
export const InteractionGetOutputSchema = AppInteractionGetOutputSchema
const ListInteractionsResponseSchema = AppInteractionListOutputSchema
const RespondToInteractionResponseSchema = AppInteractionRespondOutputSchema

export {
  AppInteractionListInputSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
}
