import { CLAUDE_CLI_CANDIDATE_VERSION, CLAUDE_SDK_CANDIDATE_VERSION } from './official.js'
import type { ClaudeInstallationInventory, ClaudeVersionEvidence } from './discovery.js'
import type { ClaudeSessionQualification } from './sessionManager.js'

export const CLAUDE_SDK_CANDIDATE_INTEGRITY = 'sha512-NSoJwEq6nFSf8dtaacYx37QdGgqApI3eHFUlxclMLYi8irb6ZJwEaUnPnLUCyAyg9W/tMkgZC0GXWLRCc01I0w=='
export const CLAUDE_SDK_CANDIDATE_PUBLISHED_AT = '2026-09-28T17:15:09.221Z'
export const CLAUDE_QUALIFICATION_REVISION = 'claude-sdk-0.3.284-v2-initial-input'

export interface ClaudeNativeQualificationEvidence {
  revision: string
  executableSha256: string
  profilePath: string
  configRevision: string
  sdkVersion: string
  sdkIntegrity: string
  authenticated: boolean
  /** These come from separately owned recorded native scenarios, never release notes. */
  checks: Readonly<Record<'firstSecondTurn' | 'exactMessageReceipt' | 'idleClose' | 'resultThenThrow' | 'wakeCorrelation' | 'exactResume' | 'forkPreservesSource' | 'exactHistory', boolean>>
}
export function qualifyClaudeCandidate(input: {
  inventory: ClaudeInstallationInventory
  version: ClaudeVersionEvidence
  native?: ClaudeNativeQualificationEvidence
}): { status: 'blocked' | 'unqualified' | 'qualified'; reasons: string[]; capabilities: ClaudeSessionQualification } {
  const capabilities: ClaudeSessionQualification = { sdkVersion: CLAUDE_SDK_CANDIDATE_VERSION, cliVersion: input.version.version ?? 'unknown', basicTurns: false, resume: false, fork: false, history: false }
  const reasons: string[] = []
  if (!input.inventory.installed) reasons.push('Claude is not installed on the selected host.')
  if (input.version.binary !== input.inventory.resolvedExecutable) reasons.push('Version probe targets another executable.')
  if (input.version.version !== CLAUDE_CLI_CANDIDATE_VERSION) reasons.push('Selected CLI differs from the exact qualification candidate.')
  if (reasons.length) return { status: 'blocked', reasons, capabilities }
  const native = input.native
  if (!native) return { status: 'unqualified', reasons: ['Version-only evidence does not establish authentication or GraphQL readiness.'], capabilities }
  if (native.revision !== CLAUDE_QUALIFICATION_REVISION || native.sdkVersion !== CLAUDE_SDK_CANDIDATE_VERSION || native.sdkIntegrity !== CLAUDE_SDK_CANDIDATE_INTEGRITY
    || native.executableSha256 !== input.inventory.executableSha256 || native.profilePath !== input.inventory.profilePath || native.configRevision !== input.inventory.configRevision) {
    return { status: 'blocked', reasons: ['Native evidence differs from the selected installation/profile/configuration or SDK integrity.'], capabilities }
  }
  if (!native.authenticated) return { status: 'blocked', reasons: ['Selected native profile is not authenticated.'], capabilities }
  const checks = native.checks
  capabilities.basicTurns = checks.firstSecondTurn && checks.exactMessageReceipt && checks.idleClose && checks.resultThenThrow && checks.wakeCorrelation
  capabilities.resume = capabilities.basicTurns && checks.exactResume
  capabilities.fork = capabilities.resume && checks.forkPreservesSource
  capabilities.history = checks.exactHistory
  if (!capabilities.basicTurns) reasons.push('Basic native lifecycle/admission scenarios are not all qualified.')
  return { status: capabilities.basicTurns ? 'qualified' : 'unqualified', reasons, capabilities }
}
