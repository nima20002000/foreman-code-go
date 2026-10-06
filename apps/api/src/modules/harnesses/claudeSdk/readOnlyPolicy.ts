import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'

const readOnlyTools = new Set(['Read', 'Glob', 'Grep', 'Bash', 'AskUserQuestion', 'WebFetch', 'WebSearch'])

/** MCP authority stays with the app; shell writes are denied by the native sandbox. */
export function claudeToolRespectsSandbox(configuration: ClaudeHarnessConfiguration, tool: string): boolean {
  return configuration.sandbox !== 'read-only' || tool.startsWith('mcp__') || readOnlyTools.has(tool)
}
