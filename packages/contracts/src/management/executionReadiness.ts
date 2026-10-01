import { z } from 'zod'

export const ExecutionReadinessInputSchema = z.object({ harness: z.enum(['codex', 'opencode', 'claude']) }).strict()
export const ExecutionReadinessSchema = z.object({
  harness: z.enum(['codex', 'opencode', 'claude']),
  scope: z.literal('saved-harness-defaults'),
  status: z.enum(['blocked', 'unverified', 'eligible']),
  rolloutEnabled: z.boolean(),
  defaultsRevision: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().datetime(),
  reason: z.object({ code: z.string(), message: z.string() }).nullable(),
  limitation: z.string(),
}).strict()
export type ExecutionReadiness = z.infer<typeof ExecutionReadinessSchema>
