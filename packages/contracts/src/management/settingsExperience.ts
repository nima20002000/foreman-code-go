import { z } from "zod";

export const SettingsAgentRoleSchema = z.enum(["operator", "orchestrator", "coder"]);
export type SettingsAgentRole = z.infer<typeof SettingsAgentRoleSchema>;
export const HarnessSettingsSectionSchema = z.enum(["model", "permissions", "session", "tools", "connections", "workspace"]);
export type HarnessSettingsSection = z.infer<typeof HarnessSettingsSectionSchema>;
export const AgentSettingsSearchSchema = z.object({
  role: SettingsAgentRoleSchema.optional().catch(undefined),
  section: z.enum(["model", "permissions", "session", "tools"]).optional().catch(undefined),
});
export const HarnessSettingsSearchSchema = z.object({
  harness: z.enum(["codex", "opencode"]).optional().catch(undefined),
  section: HarnessSettingsSectionSchema.optional().catch(undefined),
});

/** Creation suggestions only. A template never grants filesystem or runner access. */
export const WorkspaceDefaultsSchema = z.object({
  suggestedName: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
}).strict();
export type WorkspaceDefaults = z.infer<typeof WorkspaceDefaultsSchema>;
export const DEFAULT_WORKSPACE_DEFAULTS: WorkspaceDefaults = { suggestedName: "New workspace", description: "" };
export const ManagedWorkspaceDefaultsSchema = z.object({
  value: WorkspaceDefaultsSchema,
  revision: z.number().int().nonnegative(),
  versionId: z.string().min(1).nullable(),
}).strict();
export const WorkspaceDefaultsUpdateInputSchema = z.object({
  value: WorkspaceDefaultsSchema,
  commandId: z.string().trim().min(8).max(200),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type WorkspaceDefaultsUpdateInput = z.infer<typeof WorkspaceDefaultsUpdateInputSchema>;
export const WorkspaceDefaultsUpdateResultSchema = z.object({
  value: ManagedWorkspaceDefaultsSchema, replayed: z.boolean(),
}).strict();

export const BrowserCredentialSetupSchema = z.object({
  name: z.string().trim().min(1).max(80).refine((value) => !value.startsWith("-") && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), "Use a name without control characters or a leading dash"),
  days: z.number().int().min(1).max(365),
  access: z.enum(["manage", "read-only"]),
  workspaceId: z.string().trim().min(1).max(200).refine((value) => !value.startsWith("-") && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), "Use a workspace ID without control characters or a leading dash").optional(),
}).strict();
export type BrowserCredentialSetup = z.infer<typeof BrowserCredentialSetupSchema>;
