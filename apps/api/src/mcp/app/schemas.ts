import {
  DurableInteractionSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
  IdSchema,
} from '@graphql/contracts'
import { z } from 'zod'
import { AppInteractionListInputSchema } from '../../modules/interactions/app.js'

export const AppContextSchema = z.object({
  principal: z.object({
    id: IdSchema,
    audience: z.literal('worker'),
    agentId: IdSchema,
    expiresAt: z.iso.datetime(),
  }).strict(),
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
}).strict()

export const InteractionGetInputSchema = z.object({ interactionId: IdSchema }).strict()
export const InteractionGetOutputSchema = z.object({ interaction: DurableInteractionSchema }).strict()

export {
  AppInteractionListInputSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
}
