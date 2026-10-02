import type { AgentHarness } from '@graphql/contracts'
import { ExecutionReadinessSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { HarnessCatalogService } from './catalog.js'
import type { NativeRollout } from './nativeRollout.js'
import { DomainError } from '../errors.js'

/** Model-free qualification of saved defaults; run-specific admission remains authoritative. */
export class ExecutionReadinessService {
  constructor(private readonly rollout: Pick<NativeRollout, 'enabled'>,
    private readonly catalog: Pick<HarnessCatalogService, 'get'>) {}

  async get(principal: ManagementPrincipal, harness: AgentHarness) {
    requireAuthorization(principal, 'harnesses:read')
    const rolloutEnabled = this.rollout.enabled(harness)
    let entry: Awaited<ReturnType<HarnessCatalogService['get']>> | null = null
    let setupReason: { code: string; message: string } | null = null
    if (rolloutEnabled) {
      try { entry = await this.catalog.get(principal, harness) }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'HARNESS_PROFILE_REQUIRED') throw error
        setupReason = { code: error.code, message: error.message }
      }
    }
    const reason = !rolloutEnabled ? {
      code: 'NATIVE_ROLLOUT_DISABLED',
      message: harness === 'codex'
        ? 'Codex execution is disabled by this app’s runtime configuration.'
        : harness === 'claude' ? 'Claude execution is disabled by this app’s runtime configuration.'
          : 'OpenCode execution is disabled by this app’s runtime configuration.',
    } : setupReason ?? entry?.discoveryError ?? null
    const unverified = reason && /CHECK_TIMEOUT|QUALIFICATION_FAILED|DISCOVERY_UNAVAILABLE/.test(reason.code)
    return ExecutionReadinessSchema.parse({
      harness, scope: 'saved-harness-defaults', status: unverified ? 'unverified' : reason ? 'blocked' : 'eligible', rolloutEnabled,
      defaultsRevision: entry?.defaultsRevision ?? null, checkedAt: new Date().toISOString(), reason,
      limitation: 'Server availability and configured MCP do not establish execution eligibility. This checks saved harness defaults only; each Agent and Operator configuration, workspace, permissions, and MCP policy are checked again at execution.',
    })
  }
}
