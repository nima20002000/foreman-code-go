import { z } from 'zod'

/** Each computer keeps its own clone of the workspace's GitHub repository. */
export const WorkspaceRepositorySchema = z.object({
  provider: z.literal('github'),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).refine(value => value !== '.' && value !== '..'),
  defaultBranch: z.string().trim().min(1).max(255).regex(/^[^\s~^:?*[\\]+$/),
}).strict()
export type WorkspaceRepository = z.infer<typeof WorkspaceRepositorySchema>
