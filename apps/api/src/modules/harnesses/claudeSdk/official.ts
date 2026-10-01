import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { spawnNativeProcess, stopRecoveredChild, type NativeProcessRecovery } from '../recovery/processRegistry.js'
import { createClaudeSdkRunner } from './runner.js'
import type { Options, SDKUserMessage, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSdkClient } from './port.js'

export const CLAUDE_SDK_CANDIDATE_VERSION = '0.3.284'
export const CLAUDE_CLI_CANDIDATE_VERSION = '2.1.284'

/** Native history helpers read the SDK process profile, not query's child env. */
function assertHelperProfile(profilePath: string): void {
  const processProfile = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  if (resolve(profilePath) !== resolve(processProfile)) throw new Error('Claude native history helper cannot safely select a different process-local profile')
}

/** Loading occurs only at admitted startup, never at synchronous factory allocation. */
export async function loadOfficialClaudeSdk(profilePath: string, recovery: NativeProcessRecovery, binary: string): Promise<ClaudeSdkClient> {
  const require = createRequire(import.meta.url)
  const manifest = JSON.parse(await readFile(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')) as { version?: unknown }
  if (manifest.version !== CLAUDE_SDK_CANDIDATE_VERSION) throw new Error('Installed Claude SDK differs from the exact qualification candidate')
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    sdkVersion: manifest.version,
    query: ({ prompt, options }) => {
      const children = new Set<ChildProcess>()
      const query = sdk.query({ prompt: prompt as AsyncIterable<SDKUserMessage>, options: {
        ...options as Options,
        pathToClaudeCodeExecutable: binary,
        spawnClaudeCodeProcess(spawn) {
          // Fence a deferred SDK spawn after close or cancellation, including before init.
          const controller = options.abortController as AbortController | undefined
          controller?.signal.throwIfAborted()
          spawn.signal.throwIfAborted()
          // Same write-ahead scope reserved by admission; capture before any subsequent await.
          const child = spawnNativeProcess(spawn.command, spawn.args, {
            cwd: spawn.cwd ?? String(options.cwd), env: spawn.env, recovery,
          })
          children.add(child)
          return child
        },
      } })
      return {
        [Symbol.asyncIterator]: () => query[Symbol.asyncIterator](),
        interrupt: () => query.interrupt(), initializationResult: () => query.initializationResult(), mcpServerStatus: () => query.mcpServerStatus(), setMcpServers: (servers) => query.setMcpServers(servers as Record<string, McpServerConfig>), close: () => query.close(),
        async joinClosed() {
          const results = await Promise.allSettled([...children].map(async (child) => {
            if (!await stopRecoveredChild(child)) throw new Error('Claude native process closure is unverified')
          }))
          const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : [])
          if (failures.length) throw new AggregateError(failures, 'Claude owned native processes did not close')
        },
      }
    },
    getSessionInfo: async (id, options) => { assertHelperProfile(profilePath); return sdk.getSessionInfo(id, options) },
    getSessionMessages: async (id, options) => { assertHelperProfile(profilePath); return sdk.getSessionMessages(id, options) },
    forkSession: async (id, options) => { assertHelperProfile(profilePath); return sdk.forkSession(id, options) },
  }
}

/** Synchronous allocation retains the exact initially unreserved HRT recovery object. */
export function createOfficialClaudeSdkRunner(input: { profilePath: string; recovery: NativeProcessRecovery; binary: string }) {
  return createClaudeSdkRunner({ loadClient: () => loadOfficialClaudeSdk(input.profilePath, input.recovery, input.binary) })
}
