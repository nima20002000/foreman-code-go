import type { HarnessConfiguration } from '@graphql/contracts'
import type { HarnessSettingsSection, SettingsAgentRole } from '@graphql/contracts/management'

export const agentRoleOrder: readonly SettingsAgentRole[] = ['operator', 'orchestrator', 'coder']
export const rolePresentation: Record<SettingsAgentRole, { title: string; description: string; scope: string }> = {
  operator: { title: 'Operator', description: 'Your app-wide assistant.', scope: 'Shared with Operator chat. Changes apply to future chats and the next message; running responses keep their accepted settings.' },
  orchestrator: { title: 'Orchestrator', description: 'Coordinates work and reviews requests.', scope: 'Used when creating Orchestrator agents. Existing agents and runs do not change.' },
  coder: { title: 'Coder', description: 'Carries out tasks in your workflows.', scope: 'Used when creating Coder agents. Existing agents and runs do not change.' },
}
export const harnessSections: readonly { id: HarnessSettingsSection; label: string; description: string }[] = [
  { id: 'model', label: 'Model & speed', description: 'Choose the model and how it reasons.' },
  { id: 'permissions', label: 'Access & approvals', description: 'Control filesystem access and approval handling.' },
  { id: 'session', label: 'Session', description: 'History, search, plugins, and context management.' },
  { id: 'tools', label: 'Tool permissions', description: 'Choose how this configuration uses MCP tools.' },
  { id: 'connections', label: 'MCP connections', description: 'Manage connections for this harness on the server.' },
  { id: 'plugins', label: 'Plugins', description: 'Discover and manage plugins installed in Codex.' },
  { id: 'workspace', label: 'App connection', description: 'Check GraphQL MCP in a specific workspace.' },
]
export function sectionForHarnessIssue(path: readonly (string | number)[]): HarnessSettingsSection {
  const field = path.join('.')
  if (/mcp/i.test(field)) return 'tools'
  if (/sessionPersistence|requiresResume|webSearch|compaction|subagentDepth|plugins/.test(field)) return 'session'
  if (/sandbox|approval|autoApprove|permission|Writable|workspaceWrite|shellEnvironment/.test(field)) return 'permissions'
  return 'model'
}
export function harnessSummary(value: HarnessConfiguration): { label: string; value: string }[] {
  return value.harness === 'codex'
    ? [{ label: 'Harness', value: 'Codex' }, { label: 'Model', value: value.model },
      { label: 'Effort', value: value.reasoningEffort },
      { label: 'Access', value: value.sandbox === 'read-only' ? 'Read only' : value.sandbox === 'workspace-write' ? 'Workspace write' : 'Full access' },
      { label: 'Speed', value: value.serviceTier === 'priority' ? 'Fast' : 'Standard' }]
    : [{ label: 'Harness', value: 'OpenCode' }, { label: 'Model', value: value.model },
      { label: 'Variant', value: value.variant || 'Native default' }, { label: 'Native Agent', value: value.nativeAgent },
      { label: 'Thinking', value: value.thinking ? 'Shown' : 'Hidden' }]
}
