import { z } from 'zod'

export const SessionModeSchema = z.enum(['regular', 'plan'])
export type SessionMode = z.infer<typeof SessionModeSchema>
export const SessionPreferencesSchema = z.object({
  autoCompact: z.enum(['default', 'on', 'off']).default('default'),
  autoCompactTokens: z.number().int().min(100000).max(1000000).nullable().default(null),
  contextBudget: z.number().int().positive().nullable().default(null),
  contextProfile: z.string().min(1).nullable().default(null),
}).strict()
export type SessionPreferences = z.infer<typeof SessionPreferencesSchema>
const CapabilitySchema = z.object({ supported: z.boolean(), reason: z.string().nullable() }).strict()
export const SessionControlCapabilitiesSchema = z.object({
  compact: CapabilitySchema,
  plan: CapabilitySchema,
  autoCompact: CapabilitySchema,
  autoCompactBudget: CapabilitySchema,
  contextBudgets: z.array(z.number().int().positive()),
  contextProfiles: z.array(z.object({ id: z.string(), label: z.string(), capacity: z.number().int().positive() }).strict()),
  modelCapacity: z.number().int().positive().nullable(),
  model: z.string().nullable(),
  profileKey: z.string(),
}).strict()
export type SessionControlCapabilities = z.infer<typeof SessionControlCapabilitiesSchema>
export const ContextSnapshotSchema = z.object({
  nativeSessionId: z.string().min(1),
  model: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
  source: z.enum(['codex', 'claude', 'opencode']),
  accuracy: z.enum(['native', 'estimated']),
  usedTokens: z.number().nonnegative().nullable(),
  capacityTokens: z.number().positive().nullable(),
  lifetimeTokens: z.number().nonnegative().nullable(),
  cost: z.number().nonnegative().nullable(),
  stale: z.boolean(),
}).strict()
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>
export const CompactionStateSchema = z.object({
  requestId: z.string(),
  nativeSessionId: z.string().nullable(),
  nativeOperationId: z.string().nullable(),
  status: z.enum(['accepted', 'running', 'completed', 'no-op', 'failed', 'uncertain']),
  message: z.string(),
  beforeTokens: z.number().nonnegative().nullable(),
  observedAt: z.string().datetime(),
}).strict()
export type CompactionState = z.infer<typeof CompactionStateSchema>
export const SessionControlStateSchema = z.object({
  conversationId: z.string(),
  revision: z.number().int().nonnegative(),
  profileKey: z.string(),
  desiredMode: SessionModeSchema,
  appliedMode: SessionModeSchema.nullable(),
  desired: SessionPreferencesSchema,
  applied: SessionPreferencesSchema.nullable(),
  applicability: z.enum(['applied', 'next-turn', 'safe-resume', 'new-session']),
  capabilities: SessionControlCapabilitiesSchema,
  context: ContextSnapshotSchema.nullable(),
  compaction: CompactionStateSchema.nullable(),
  busyReason: z.string().nullable(),
}).strict()
export type SessionControlState = z.infer<typeof SessionControlStateSchema>
const RequestFields = { requestId: z.string().min(8).max(200), expectedRevision: z.number().int().nonnegative() }
export const SessionControlRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...RequestFields, kind: z.literal('compact') }).strict(),
  z.object({ ...RequestFields, kind: z.literal('mode'), mode: SessionModeSchema }).strict(),
  z.object({ ...RequestFields, kind: z.literal('preferences'), preferences: SessionPreferencesSchema }).strict(),
])
export type SessionControlRequest = z.infer<typeof SessionControlRequestSchema>

export function unavailableSessionControls(profileKey: string): SessionControlCapabilities {
  const unavailable = { supported: false, reason: 'Send a message to discover this native session’s controls.' }
  return { compact: unavailable, plan: unavailable, autoCompact: unavailable, autoCompactBudget: unavailable,
    contextBudgets: [], contextProfiles: [], modelCapacity: null, model: null, profileKey }
}

export function compactionBlocksSend(compaction: CompactionState | null): boolean {
  return !!compaction && ['accepted', 'running', 'uncertain'].includes(compaction.status)
}
