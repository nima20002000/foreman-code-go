import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { ExecutionReadinessService } from '../src/modules/harnesses/executionReadiness.js'
import type { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'

const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['harnesses:read'], scope: {} }] }
const catalog = (discoveryError: { code: string; message: string } | null = null) => ({ get: vi.fn(async () => ({ defaultsRevision: 7, discoveryError })) }) as unknown as Pick<HarnessCatalogService, 'get'>

describe('execution readiness', () => {
  it.each(['codex', 'opencode'] as const)('reports explicitly disabled %s execution without probing', async (harness) => {
    const source = catalog()
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0', GRAPHQL_OPENCODE_PARITY_QUALIFIED: '0' }), source).get(principal, harness)
    expect(result).toMatchObject({ status: 'blocked', rolloutEnabled: false, reason: { code: 'NATIVE_ROLLOUT_DISABLED' } })
    expect(source.get).not.toHaveBeenCalled()
  })
  it.each(['codex', 'opencode'] as const)('enables supported local %s by default and still qualifies its saved configuration', async (harness) => {
    const source = catalog()
    expect(await new ExecutionReadinessService(new NativeRollout({}), source).get(principal, harness)).toMatchObject({ status: 'eligible', rolloutEnabled: true })
    expect(source.get).toHaveBeenCalledWith(principal, harness)
  })
  it.each([{ HOST: '0.0.0.0' }, { GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: 'invalid' }, { NODE_ENV: 'production' }])('does not implicitly enable Codex for %j', (environment) => {
    expect(new NativeRollout(environment).enabled('codex')).toBe(false)
  })
  it('keeps OpenCode production qualification explicit and rejects invalid or non-local automatic startup', () => {
    expect(new NativeRollout({ NODE_ENV: 'production' }).enabled('opencode')).toBe(false)
    expect(new NativeRollout({ NODE_ENV: 'production', GRAPHQL_OPENCODE_PARITY_QUALIFIED: '1' }).enabled('opencode')).toBe(true)
    expect(new NativeRollout({ HOST: '0.0.0.0' }).enabled('opencode')).toBe(false)
    expect(new NativeRollout({ GRAPHQL_OPENCODE_PARITY_QUALIFIED: 'invalid' }).enabled('opencode')).toBe(false)
  })
  it.each(['CODEX_VERSION_UNQUALIFIED', 'CODEX_AUTH_UNAVAILABLE', 'CODEX_MODEL_UNAVAILABLE'])('reports existing qualification failure %s', async (code) => {
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog({ code, message: 'Safe diagnostic' })).get(principal, 'codex')
    expect(result).toMatchObject({ status: 'blocked', defaultsRevision: 7, reason: { code } })
  })
  it('labels inconclusive checks as unverified', async () => {
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog({ code: 'HARNESS_CHECK_TIMEOUT', message: 'Timed out' })).get(principal, 'codex')
    expect(result.status).toBe('unverified')
  })
  it('reads qualification of saved defaults and retains its revision', async () => {
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog()).get(principal, 'codex')
    expect(result).toMatchObject({ status: 'eligible', scope: 'saved-harness-defaults', defaultsRevision: 7, reason: null })
  })
  it('never enables Codex in production and denies ungranted reads', async () => {
    const service = new ExecutionReadinessService(new NativeRollout({ NODE_ENV: 'production', GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog())
    expect((await service.get(principal, 'codex')).status).toBe('blocked')
    await expect(service.get({ ...principal, grants: [] }, 'codex')).rejects.toMatchObject({ status: 403 })
  })
})
