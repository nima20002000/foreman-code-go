import pg from 'pg'
import { expect, it } from 'vitest'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { passiveDriverPayloads } from '../src/modules/harnesses/payloadDiscovery.js'
import { discoverLauncher } from '../src/modules/harnesses/hostDiscovery.js'

it('pins actual main installation payloads and invalidates selections after passive refresh', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  let payload = 'payload-A'
  let reads = 0
  const launcher: typeof discoverLauncher = async (requested, environment, paths = []) => {
    reads++
    return { requested, resolvedLauncher: `/recorded/${requested}`, fingerprint: payload,
      payloadFingerprints: paths.map((path) => ({ path, fingerprint: payload })), status: 'installed',
      interpreter: null, diagnostics: [], environment, checkedAt: '2026-10-01T00:00:00.000Z' }
  }
  const payloads: typeof passiveDriverPayloads = async () => ({ complete: true, paths: ['/recorded/provider-payload'] })
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex', openCodeBinary: 'opencode' },
    async () => ({ revision: 8, defaults: {
      codex: { harness: 'codex', model: 'recorded-model', reasoningEffort: 'medium', serviceTier: 'standard', sandbox: 'read-only' },
      opencode: { harness: 'opencode', model: 'recorded/model', variant: '', nativeAgent: 'build', thinking: false, autoApprove: false },
    } }), new HostHarnessProfileEvidenceRepository(pool), () => null, { PATH: '/recorded' }, { launcher, payloads })
  try {
    await registry.initialize('d46e2a2b-130f-46de-a93b-78a2352b9c9d')
    const selection = registry.pinDefault('codex')
    expect(selection.selection.hostRef).toEqual({ kind: 'main', mainId: 'd46e2a2b-130f-46de-a93b-78a2352b9c9d' })
    expect(selection.installation.installationFingerprint).toBe('payload-A')
    expect(selection.installation.qualified).toBeNull()
    expect(reads).toBe(4)
    await registry.refreshMain()
    expect(() => registry.installations.assertCurrent(selection)).not.toThrow()
    payload = 'payload-B'
    await registry.refreshMain()
    expect(() => registry.installations.assertCurrent(selection)).toThrow()
    expect(registry.pinDefault('codex').installation.installationFingerprint).toBe('payload-B')
    registry.stop()
    expect(() => registry.pinDefault('codex')).toThrow('shutting down')
  } finally { await pool.end() }
})
