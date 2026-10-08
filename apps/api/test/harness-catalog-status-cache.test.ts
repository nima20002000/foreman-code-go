import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, HarnessDefaultsSchema, type HarnessConfiguration } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'

const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['harnesses:read'], scope: {} }] }

function fixture(ready = () => true) {
  const qualify = vi.fn(async (configuration: HarnessConfiguration) => ({ harness: configuration.harness,
    version: 'fixture', authenticated: ready(), ready: ready(), structuredEvents: true, supportsResume: true,
    supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
    supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }))
  const settings = { getManagedHarnessDefaults: async () => ({ revision: 3,
    defaults: HarnessDefaultsSchema.parse({ ...DEFAULT_HARNESS_DEFAULTS, claude: {
      harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/unit/claude-profile',
      permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } }) }) } as unknown as PostgresSettingsRepository
  const catalog = new HarnessCatalogService({ qualify }, settings, {} as PostgresCommandCoordinator, '/unit/qualification')
  return { catalog, qualify }
}

describe('harness catalog status reads', () => {
  it('reuses a settled check across polled reads without native work', async () => {
    const { catalog, qualify } = fixture()
    const first = await catalog.list(principal)
    expect(first.map(entry => entry.discoveryError)).toEqual([null, null])
    expect(qualify).toHaveBeenCalledTimes(2)
    expect(await catalog.list(principal)).toEqual(first)
    expect((await catalog.get(principal, 'codex')).capability).toEqual(first[0]!.capability)
    expect(qualify).toHaveBeenCalledTimes(2)
  })

  it('keeps writer qualification fresh and re-reads after invalidation', async () => {
    let ready = true
    const { catalog, qualify } = fixture(() => ready)
    await catalog.list(principal)
    expect((await catalog.checkConfiguration(principal, DEFAULT_HARNESS_DEFAULTS.codex)).qualification.ready).toBe(true)
    expect(qualify).toHaveBeenCalledTimes(2)
    ready = false
    await expect(catalog.qualifyConfiguration(DEFAULT_HARNESS_DEFAULTS.codex)).rejects.toMatchObject({ code: 'HARNESS_DEFAULTS_UNQUALIFIED' })
    expect(qualify).toHaveBeenCalledTimes(3)
    expect((await catalog.get(principal, 'codex')).discoveryError).toBeNull()
    catalog.invalidateChecks()
    expect((await catalog.get(principal, 'codex')).discoveryError).toMatchObject({ code: 'HARNESS_DEFAULTS_UNQUALIFIED' })
    expect(qualify).toHaveBeenCalledTimes(4)
  })
})
