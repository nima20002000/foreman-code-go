import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { NativeProcessRegistry, spawnNativeProcess, stopRecoveredChild, type NativeProcessRecovery } from '../recovery/processRegistry.js'
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
export async function loadInstalledClaudeSdk(sdkEntrypoint?: string): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  const require = createRequire(import.meta.url)
  const entrypoint = sdkEntrypoint ?? require.resolve('@anthropic-ai/claude-agent-sdk')
  if (!isAbsolute(entrypoint) || entrypoint.includes('\0')) throw new Error('Claude SDK requires its qualified absolute entrypoint')
  const manifest = JSON.parse(await readFile(join(dirname(entrypoint), 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
  if (manifest.name !== '@anthropic-ai/claude-agent-sdk' || manifest.version !== CLAUDE_SDK_CANDIDATE_VERSION) {
    throw new Error('Installed Claude SDK differs from the exact qualification candidate')
  }
  return import(pathToFileURL(entrypoint).href)
}

export async function loadOfficialClaudeSdk(profilePath: string, recovery: NativeProcessRecovery, binary: string,
  sdkEntrypoint?: string): Promise<ClaudeSdkClient> {
  const sdk = await loadInstalledClaudeSdk(sdkEntrypoint)
  return {
    sdkVersion: manifest.version,
    ...ownedClaudeSdkQueries({ sdk, recovery, binary }),
    getSessionInfo: async (id, options) => { assertHelperProfile(profilePath); return sdk.getSessionInfo(id, options) },
    getSessionMessages: async (id, options) => { assertHelperProfile(profilePath); return sdk.getSessionMessages(id, options) },
    listSubagents: async (id, options) => { assertHelperProfile(profilePath); return sdk.listSubagents(id, options) },
    getSubagentMessages: async (id, agentId, options) => { assertHelperProfile(profilePath); return sdk.getSubagentMessages(id, agentId, options) },
    forkSession: async (id, options) => { assertHelperProfile(profilePath); return sdk.forkSession(id, options) },
  }
}

/** Reserve native ownership before SDK dispatch, including queries that never spawn. */
export function ownedClaudeSdkQueries(input: {
  sdk: Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query'>
  recovery: NativeProcessRecovery
  binary: string
}): Pick<ClaudeSdkClient, 'query' | 'requiresRuntimeClosure'> {
  const registry = new NativeProcessRegistry(input.recovery.root)
  const unclosed = new Set<NativeProcessRecovery>()
  let usedReservation = false
  return {
    requiresRuntimeClosure: () => unclosed.size > 0,
    async query({ prompt, options, scope }) {
      const recovery = input.recovery.launchId && !usedReservation
        ? input.recovery : registry.reserveLaunch(input.recovery.owner)
      usedReservation = true
      unclosed.add(recovery)
      const children = new Set<ChildProcess>()
      let stopped = false
      const joinClosed = async () => {
        if (!unclosed.has(recovery)) return
        stopped = true
        await Promise.all([...children].map(async child => {
          if (!await stopRecoveredChild(child)) throw new Error('Claude native process closure is unverified')
        }))
        await registry.abandonReservedLaunch(recovery)
        if (!await registry.closeOwner(recovery.owner)) throw new Error('Claude native launch closure is unverified')
        unclosed.delete(recovery)
      }
      try {
        const query = input.sdk.query({ prompt: prompt as AsyncIterable<SDKUserMessage>, options: {
          ...options as Options,
          pathToClaudeCodeExecutable: input.binary,
          spawnClaudeCodeProcess(spawn) {
            if (stopped) throw new Error('The owned Claude query closed before native launch')
            const controller = options.abortController as AbortController | undefined
            controller?.signal.throwIfAborted()
            spawn.signal.throwIfAborted()
            const child = spawnNativeProcess(spawn.command, spawn.args, {
              cwd: spawn.cwd ?? String(options.cwd), env: spawn.env, recovery, ...(scope ? { claudeSessionScope: scope } : {}),
            })
            children.add(child)
            return child
          },
        } })
        return {
          [Symbol.asyncIterator]: () => query[Symbol.asyncIterator](),
          setPermissionMode: mode => query.setPermissionMode(mode),
          getContextUsage: options => query.getContextUsage(options),
          interrupt: () => query.interrupt(),
          initializationResult: () => query.initializationResult(),
          mcpServerStatus: () => query.mcpServerStatus(),
          setMcpServers: (servers: Readonly<Record<string, unknown>>) =>
            query.setMcpServers(servers as Record<string, McpServerConfig>),
          close: () => { stopped = true; query.close() },
          joinClosed,
        }
      } catch (error) {
        await joinClosed()
        throw error
      }
    },
  }
}

/** Synchronous allocation retains the exact initially unreserved HRT recovery object. */
export function createOfficialClaudeSdkRunner(input: { profilePath: string; recovery: NativeProcessRecovery; binary: string }) {
  return createClaudeSdkRunner({ loadClient: () => loadOfficialClaudeSdk(input.profilePath, input.recovery, input.binary) })
}
