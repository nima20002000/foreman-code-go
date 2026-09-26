import { z } from 'zod'

export const RuntimeIdentitySchema = z.object({
  installationId: z.string().uuid(),
  checkoutId: z.string().regex(/^[a-f0-9]{64}$/),
  databaseId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>
