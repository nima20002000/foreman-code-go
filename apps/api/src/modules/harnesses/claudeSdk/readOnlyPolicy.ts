import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const readOnlyTools = new Set(['Read', 'Glob', 'Grep', 'Bash', 'AskUserQuestion', 'WebFetch', 'WebSearch'])

/** MCP authority stays with the app; shell writes are denied by the native sandbox. */
export function claudeToolRespectsSandbox(configuration: ClaudeHarnessConfiguration, tool: string): boolean {
  return configuration.sandbox !== 'read-only' || tool.startsWith('mcp__') || readOnlyTools.has(tool)
}

export function claudeReadOnlyWritePaths(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const userTemporaryDirectory = `claude-${process.getuid?.() ?? 0}`
  // Linux applies denies only within writable mounts; denying '/' leaves the SDK's writable mounts intact.
  const paths = [cwd, '~/.npm/_logs', '~/.claude/debug', '/tmp/claude', '/private/tmp/claude',
    join('/tmp', userTemporaryDirectory), join('/private/tmp', userTemporaryDirectory),
    join(env.TMPDIR || env.TMP || env.TEMP || tmpdir(), userTemporaryDirectory)]
  let gitFile: string
  try {
    gitFile = readFileSync(join(cwd, '.git'), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') return [...new Set(paths)]
    throw error
  }
  const gitDirectory = gitFile.match(/^gitdir:\s*(.+)$/m)?.[1]
  if (gitDirectory) {
    const directory = resolve(cwd, gitDirectory.trim())
    const commonDirectory = dirname(dirname(directory))
    if (basename(dirname(directory)) === 'worktrees' && basename(commonDirectory).endsWith('.git')) {
      paths.push(commonDirectory)
    }
  }
  return [...new Set(paths)]
}

/** A failed sandbox launch is not proof that the sandbox rejected a write. */
export function claudeSandboxStartupFailure(content: unknown): { code: string; message: string } | undefined {
  if (!/apply-seccomp:.*\/proc\/self\/(?:setgroups|uid_map|gid_map)/s.test(JSON.stringify(content))) return undefined
  return { code: 'CLAUDE_SANDBOX_UNAVAILABLE',
    message: 'The native Claude shell sandbox could not start on this computer. Read-only execution remains blocked.' }
}
