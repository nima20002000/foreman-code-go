import { z } from 'zod'

export const RuntimeIdentitySchema = z.object({
  installationId: z.string().uuid(),
  checkoutId: z.string().regex(/^[a-f0-9]{64}$/),
  databaseId: z.string().regex(/^[a-f0-9]{64}$/),
  testResourcesId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>

/** Browser requests belong to the installation verified before rendering the document. */
export const RUNTIME_INSTALLATION_HEADER = 'x-foreman-installation-id'
export const RuntimeInstallationHeaderSchema = RuntimeIdentitySchema.shape.installationId
