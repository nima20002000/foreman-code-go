import { z } from 'zod'
import { AcceptedNodePlacementSchema, DispatchIntentSchema } from './nodePlacement.js'
export const ExecutionAuthorityRequestSchema = z.object({ version: z.literal(1),
  action: z.enum(['start', 'read', 'control']), intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema,
}).strict()
export const ExecutionAuthorityResultSchema = z.object({ version: z.literal(1),
  action: z.enum(['start', 'read', 'control']), operationId: z.string().min(1), attemptId: z.string().min(1),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/), owner: DispatchIntentSchema.shape.owner,
}).strict()
export const EXECUTION_AUTHORITY_EXTENSION = { namespace: 'execution-authority-v1', version: 1 as const,
  role: 'duplex' as const, maxJsonBytes: 256 * 1024, maxBinaryBytes: 0 }
