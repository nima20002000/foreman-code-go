import { z } from 'zod'
import { GraphqlToolDefaultsSchema, GraphqlToolOverrideSchema, HarnessConfigurationSchema } from '@graphql/contracts'

// Raw form state is browser-only, including unfinished JSON. Publication still
// uses the shared Agent and harness validation through Save agent settings.
const HarnessFormSchema = z.object({ configuration: HarnessConfigurationSchema,
  shellEnvironmentText: z.string(), mcpText: z.string() }).strict()
export const AgentFormSchema = z.object({ base: z.string().refine((value) => { try { JSON.parse(value); return true } catch { return false } }), name: z.string(), prompt: z.string(),
  editor: HarnessFormSchema.extend({ drafts: z.object({ codex: HarnessFormSchema.optional(),
    opencode: HarnessFormSchema.optional() }).strict().optional() }),
  graphqlTools: z.object({ defaults: GraphqlToolDefaultsSchema.optional(), override: GraphqlToolOverrideSchema.optional() }).strict().optional(),
}).strict()
export type AgentForm = z.infer<typeof AgentFormSchema>
