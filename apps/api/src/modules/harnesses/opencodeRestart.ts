import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ManagedOpenCodeServerOptions } from './opencodeTransport.js'
import type { ChildProcessEnvironment } from './port.js'
import { HarnessExecutionError } from './errors.js'
import { readDetachedNativeProcess, type NativeLaunchObservation } from './recovery/processRegistry.js'
import { readRecord, recordObject, writeRecord } from './recovery/storage.js'

export interface OpenCodeRestartState {
  launch: NativeLaunchObservation
  baseUrl: string
  password: string
  environment: ChildProcessEnvironment
  version: string
  generation: number
  references: Readonly<Record<string, string>>
}

function binding(options: ManagedOpenCodeServerOptions) {
  return { binary: options.binary, workingDirectory: options.workingDirectory, ownerAgentId: options.ownerAgentId,
    advancedConfiguration: options.advancedConfiguration ?? null, pure: options.pure ?? null,
    credentialEnvironmentVariable: options.credentialEnvironmentVariable ?? null,
    appMcpAccess: options.appMcpAccess ?? null, appMcpServerName: options.appMcpServerName ?? null }
}

function recordPath(options: ManagedOpenCodeServerOptions, launch: NativeLaunchObservation): string {
  const recovery = options.processRecovery
  if (!recovery || recovery.owner !== launch.owner) throw new Error('OpenCode restart has no matching process owner.')
  const ownerKey = createHash('sha256').update(recovery.owner).digest('hex')
  return join(recovery.root, ownerKey, launch.launchId, 'opencode-resident.json')
}

export function writeOpenCodeRestart(options: ManagedOpenCodeServerOptions, state: OpenCodeRestartState): void {
  writeRecord(recordPath(options, state.launch), { format: 1, binding: binding(options), ...state })
}

export function readOpenCodeRestart(options: ManagedOpenCodeServerOptions): OpenCodeRestartState | undefined {
  if (!options.restartDetachable || !options.processRecovery) return undefined
  const launch = readDetachedNativeProcess(options.processRecovery)
  if (!launch) return undefined
  const row = recordObject(readRecord(recordPath(options, launch)))
  const environment = recordObject(row.environment)
  const variables = recordObject(environment.variables)
  const references = recordObject(row.references)
  if (row.format !== 1 || !isDeepStrictEqual(row.binding, binding(options))
    || !isDeepStrictEqual(row.launch, launch) || typeof row.baseUrl !== 'string'
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(row.baseUrl)
    || Number(new URL(row.baseUrl).port) > 65535
    || typeof row.password !== 'string' || !/^[0-9a-f]{64}$/.test(row.password)
    || typeof row.version !== 'string' || !row.version.trim()
    || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1
    || environment.agentId !== options.ownerAgentId
    || Object.values(variables).some((value) => typeof value !== 'string')
    || Object.values(references).some((value) => typeof value !== 'string')) {
    throw new HarnessExecutionError('OPENCODE_RESTART_IDENTITY_CONFLICT', 'The retained OpenCode server identity changed.')
  }
  return { launch, baseUrl: row.baseUrl, password: row.password, version: row.version,
    generation: Number(row.generation), references: references as Record<string, string>,
    environment: { agentId: options.ownerAgentId, variables: variables as Record<string, string> } }
}
