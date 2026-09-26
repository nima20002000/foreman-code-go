import type { AgentHarness } from '@graphql/contracts'
import { ExecutionReadinessSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { HarnessCatalogService } from './catalog.js'
import type { NativeRollout } from './nativeRollout.js'

/** Model-free qualification of saved defaults; run-specific admission remains authoritative. */
export class ExecutionReadinessService {
  constructor(private readonly rollout: Pick<NativeRollout, 'enabled'>,
    private readonly catalog: Pick<HarnessCatalogService, 'get'>) {}

  async get(principal: ManagementPrincipal, harness: AgentHarness) {
    requireAuthorization(principal, 'harnesses:read')
    const rolloutEnabled = this.rollout.enabled(harness)
    const entry = rolloutEnabled ? await this.catalog.get(principal, harness) : null
    const reason = !rolloutEnabled ? {
      code: 'NATIVE_ROLLOUT_DISABLED',
      message: harness === 'codex'
        ? 'Codex execution requires explicit experimental opt-in outside production.'
        : 'OpenCode execution requires explicit completed parity qualification.',
    } : entry?.discoveryError ?? null
    const unverified = reason && /CHECK_TIMEOUT|QUALIFICATION_FAILED|DISCOVERY_UNAVAILABLE/.test(reason.code)
    return ExecutionReadinessSchema.parse({
      harness, scope: 'saved-harness-defaults', status: unverified ? 'unverified' : reason ? 'blocked' : 'eligible', rolloutEnabled,
      defaultsRevision: entry?.defaultsRevision ?? null, checkedAt: new Date().toISOString(), reason,
      limitation: 'Server availability and configured MCP do not establish execution eligibility. This checks saved harness defaults only; each Agent and Operator configuration, workspace, permissions, and MCP policy are checked again at execution.',
    })
  }
}
