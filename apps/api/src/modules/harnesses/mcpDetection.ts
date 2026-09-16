import { McpDetectionSchema, type AgentHarness, type McpDetection } from '@graphql/contracts'

import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, type IssuedWorkerCredential, type WorkerCredentialService } from '../access/workerCredentials.js'
import { DomainError } from '../errors.js'

export type NativeMcpStatus = 'connected' | 'disabled' | 'authentication_required' | 'broken' | 'status_unavailable'

export interface NativeMcpEntryEvidence {
  name: string
  transport: 'streamable-http' | 'sse' | 'stdio' | 'unknown'
  endpoint?: string
  enabled?: boolean
  credentialEnvironmentVariable?: string
  status?: NativeMcpStatus
  detail?: string
  enabledTools?: readonly string[]
  disabledTools?: readonly string[]
  nativeFilterDiagnostics?: readonly string[]
}

export interface NativeMcpInspectionEvidence {
  harness: AgentHarness
  providerVersion: string
  runnerId: string
  workingDirectory: string
  inspectedAt: string
  entry?: NativeMcpEntryEvidence
}

export interface NativeMcpInspector {
  inspect(input: {
    harness: AgentHarness
    runnerId: string
    workingDirectory: string
    serverName: string
    signal?: AbortSignal
  }): Promise<NativeMcpInspectionEvidence>
}

export interface ScopedMcpDetection {
  detection: McpDetection
  runnerId: string
  workingDirectory: string
  providerVersion: string
  nativeFilters: {
    enabledTools?: readonly string[]
    disabledTools?: readonly string[]
    diagnostics?: readonly string[]
  }
}

function endpointMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  try {
    const left = new URL(actual)
    const right = new URL(expected)
    return left.protocol === right.protocol && left.host === right.host
      && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
      && left.search === right.search && left.hash === right.hash
  } catch {
    return false
  }
}

function safeDetail(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,"']+/gi, '$1=[REDACTED]')
    .slice(0, 500)
}

export class McpDetectionService {
  constructor(
    private readonly inspector: NativeMcpInspector,
    private readonly expectedEndpoint: string,
    private readonly serverName = 'graphql-app',
  ) {}

  async inspect(input: {
    harness: AgentHarness
    runnerId: string
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<ScopedMcpDetection> {
    let evidence: NativeMcpInspectionEvidence
    try {
      evidence = await this.inspector.inspect({ ...input, serverName: this.serverName })
    } catch (error) {
      return {
        detection: McpDetectionSchema.parse({
          harness: input.harness,
          serverName: this.serverName,
          state: 'check_failed',
          endpointMatches: null,
          credentialEnvironmentVariable: null,
          checkedAt: new Date().toISOString(),
          detail: safeDetail(error instanceof Error ? error.message : 'Native MCP inspection failed.'),
        }),
        runnerId: input.runnerId,
        workingDirectory: input.workingDirectory,
        providerVersion: 'unknown',
        nativeFilters: {},
      }
    }
    if (evidence.harness !== input.harness || evidence.runnerId !== input.runnerId
      || evidence.workingDirectory !== input.workingDirectory) {
      throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'Native MCP inspection returned evidence for another launch context.', 500)
    }
    const entry = evidence.entry
    const matches = entry ? endpointMatches(entry.endpoint, this.expectedEndpoint) : null
    const nameMatches = entry?.name === this.serverName
    const credentialMatches = entry?.credentialEnvironmentVariable === APP_MCP_TOKEN_ENVIRONMENT_VARIABLE
    const transportMatches = entry?.transport === 'streamable-http'
    let state: McpDetection['state']
    if (!entry) state = 'not_detected'
    else if (!nameMatches || !matches || !credentialMatches || !transportMatches) state = 'misconfigured'
    else if (entry.enabled === false || entry.status === 'disabled') state = 'disabled'
    else state = entry.status ?? 'status_unavailable'
    return {
      detection: McpDetectionSchema.parse({
        harness: input.harness,
        serverName: this.serverName,
        state,
        endpointMatches: matches,
        credentialEnvironmentVariable: entry?.credentialEnvironmentVariable ?? null,
        checkedAt: evidence.inspectedAt,
        ...(entry?.detail ? { detail: safeDetail(entry.detail) } : {}),
      }),
      runnerId: evidence.runnerId,
      workingDirectory: evidence.workingDirectory,
      providerVersion: evidence.providerVersion,
      nativeFilters: {
        ...(entry?.enabledTools ? { enabledTools: entry.enabledTools } : {}),
        ...(entry?.disabledTools ? { disabledTools: entry.disabledTools } : {}),
        ...(entry?.nativeFilterDiagnostics ? { diagnostics: entry.nativeFilterDiagnostics } : {}),
      },
    }
  }

  async preflight(input: {
    harness: AgentHarness
    runnerId: string
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<ScopedMcpDetection> {
    const result = await this.inspect(input)
    if (result.detection.state !== 'connected' && result.detection.state !== 'status_unavailable') {
      throw new DomainError('APP_MCP_PREFLIGHT_FAILED', `App MCP credential injection refused: ${result.detection.state}.`, 409)
    }
    return result
  }
}

/** Native filters only remove tools from the already-authorized App catalog. */
export function intersectNativeToolFilters(
  authorized: readonly string[],
  filters: ScopedMcpDetection['nativeFilters'],
): string[] {
  const enabled = filters.enabledTools ? new Set(filters.enabledTools) : undefined
  const disabled = new Set(filters.disabledTools ?? [])
  return authorized.filter((tool) => (!enabled || enabled.has(tool)) && !disabled.has(tool))
}

export class WorkerLaunchCredentialService implements ExecutionCredentialProvider {
  constructor(
    private readonly detection: McpDetectionService,
    private readonly credentials: WorkerCredentialService,
    private readonly runnerId: string,
  ) {}

  async prepare(input: {
    executionId: string
    harness: AgentHarness
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<{ credential: IssuedWorkerCredential; detection: ScopedMcpDetection }> {
    const detection = await this.detection.preflight({
      harness: input.harness,
      runnerId: this.runnerId,
      workingDirectory: input.workingDirectory,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    // Issuance is intentionally after endpoint/auth-reference verification.
    const credential = await this.credentials.issueForExecution(input.executionId)
    return { credential, detection }
  }

  revoke(credential: IssuedWorkerCredential): Promise<void> {
    return this.credentials.revoke(credential)
  }

  revokeForExecution(executionId: string): Promise<number> {
    return this.credentials.revokeForExecution(executionId)
  }
}

export interface ExecutionCredentialPrepareInput {
  executionId: string
  harness: AgentHarness
  workingDirectory: string
  signal?: AbortSignal
}

export interface PreparedExecutionCredential {
  credential: IssuedWorkerCredential
  detection: ScopedMcpDetection
}

/** Provider-neutral lifecycle seam consumed by legacy and rich session execution paths. */
export interface ExecutionCredentialProvider {
  prepare(input: ExecutionCredentialPrepareInput): Promise<PreparedExecutionCredential>
  revoke(credential: IssuedWorkerCredential): Promise<void>
  revokeForExecution(executionId: string): Promise<number>
}
