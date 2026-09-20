import { z } from 'zod'

const PluginId = z.string().min(3).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/)
const Revision = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const CommandId = z.string().uuid()

export const CodexPluginSummarySchema = z.object({
  pluginId: PluginId, name: z.string(), marketplaceName: z.string(), version: z.string().nullable(),
  installed: z.boolean(), enabled: z.boolean(), sourceType: z.enum(['local', 'git', 'git-subdir', 'remote', 'other']),
  installPolicy: z.enum(['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT']),
  authPolicy: z.enum(['ON_INSTALL', 'ON_USE']),
}).strict()
export type CodexPluginSummary = z.infer<typeof CodexPluginSummarySchema>

export const CodexPluginListInputSchema = z.object({
  view: z.enum(['installed', 'available']).default('installed'), query: z.string().trim().max(100).default(''),
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(48).default(24),
}).strict()
export type CodexPluginListInput = z.infer<typeof CodexPluginListInputSchema>
export const CodexPluginListResultSchema = z.object({
  items: z.array(CodexPluginSummarySchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  revision: Revision, checkedAt: z.string().datetime({ offset: true }),
}).strict()
export type CodexPluginListResult = z.infer<typeof CodexPluginListResultSchema>

export const CodexPluginGetInputSchema = z.object({ pluginId: PluginId }).strict()
export const CodexPluginDetailResultSchema = z.object({ plugin: CodexPluginSummarySchema,
  contents: z.discriminatedUnion('status', [
    z.object({ status: z.literal('known'), skills: z.array(z.string()), hooks: z.array(z.string()), mcpServers: z.array(z.string()), apps: z.array(z.string()) }).strict(),
    z.object({ status: z.literal('unknown') }).strict(),
  ]),
}).strict()
export type CodexPluginDetailResult = z.infer<typeof CodexPluginDetailResultSchema>

export const CodexPluginChangeInputSchema = z.object({ pluginId: PluginId, action: z.enum(['install', 'remove']),
  expectedRevision: Revision, commandId: CommandId }).strict()
export type CodexPluginChangeInput = z.infer<typeof CodexPluginChangeInputSchema>
export const CodexPluginChangeResultSchema = z.object({ pluginId: PluginId, action: z.enum(['install', 'remove']),
  status: z.enum(['applied', 'uncertain']), message: z.string() }).strict()
export type CodexPluginChangeResult = z.infer<typeof CodexPluginChangeResultSchema>
