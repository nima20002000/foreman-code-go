import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'

const readOnlyTools = new Set(['Read', 'Glob', 'Grep', 'Bash', 'AskUserQuestion', 'WebFetch', 'WebSearch'])

/** MCP authority stays with the app; shell writes are denied by the native sandbox. */
export function claudeToolRespectsSandbox(configuration: ClaudeHarnessConfiguration, tool: string): boolean {
  return configuration.sandbox !== 'read-only' || tool.startsWith('mcp__') || readOnlyTools.has(tool)
}

/** A failed sandbox launch is not proof that the sandbox rejected a write. */
export function claudeSandboxStartupFailure(content: unknown): { code: string; message: string } | undefined {
  if (!/apply-seccomp:.*\/proc\/self\/(?:setgroups|uid_map|gid_map)/s.test(JSON.stringify(content))) return undefined
  return { code: 'CLAUDE_SANDBOX_UNAVAILABLE',
    message: 'The native Claude shell sandbox could not start on this computer. Read-only execution remains blocked.' }
}
