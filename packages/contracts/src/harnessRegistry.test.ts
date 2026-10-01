import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from './index.js'
import { HostHarnessOverrideSaveSchema, ConfiguredHarnessInstanceSchema, HarnessHostReferenceSchema } from './harnessRegistry.js'

describe('public harness registry contracts', () => {
  it('uses canonical main/device references and does not accept an independent host UUID', () => {
    const mainId = '00000000-0000-4000-8000-000000000001'
    expect(HarnessHostReferenceSchema.parse({ kind: 'main', mainId })).toEqual({ kind: 'main', mainId })
    expect(HarnessHostReferenceSchema.safeParse({ hostId: mainId }).success).toBe(false)
  })
  it('keeps unavailable instances visible without exposing opaque configurations', () => {
    const record = { instanceId: 'unknown', instanceRevision: '1', driverId: 'unsupported', enabled: true, availability: 'unknown-driver', configuration: null }
    expect(ConfiguredHarnessInstanceSchema.parse(record)).toEqual(record)
    expect(ConfiguredHarnessInstanceSchema.safeParse({ ...record, configuration: { credential: 'secret' } }).success).toBe(false)
  })
})

it('rejects inline provider credentials in host overrides while allowing ordinary environment values', () => {
  const input = { commandId: '00000000-0000-4000-8000-000000000003', instanceId: '00000000-0000-4000-8000-000000000004', expectedRevision: 0,
    target: { hostRef: { kind: 'main', mainId: '00000000-0000-4000-8000-000000000001' }, applicationInstallationId: '00000000-0000-4000-8000-000000000001', harnessInstallationId: 'codex', installationFingerprint: 'sha' },
    presetId: 'local-default:codex', enabled: true, configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard',
      advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, shellEnvironment: { inherit: 'core', ignoreDefaultExcludes: false, filters: {}, set: { LANG: 'C' } } } } }
  expect(HostHarnessOverrideSaveSchema.safeParse(input).success).toBe(true)
  const rejected = HostHarnessOverrideSaveSchema.safeParse({ ...input, configuration: { ...input.configuration, advanced: { ...input.configuration.advanced,
    shellEnvironment: { ...input.configuration.advanced.shellEnvironment, set: { OPENAI_API_KEY: 'never-store-this-marker' } } } } })
  expect(rejected.success).toBe(false)
  if (!rejected.success) expect(JSON.stringify(rejected.error.issues)).not.toContain('never-store-this-marker')
})
