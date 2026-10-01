import { describe, expect, it } from 'vitest'
import { projectHarnessInstance } from '../src/modules/harnesses/registryProjection.js'

describe('public registry projection', () => {
  it('does not expose unsupported or invalid raw configuration', () => {
    const result = projectHarnessInstance({ instanceId: 'unknown', instanceRevision: '1', driverId: 'unknown', enabled: true, availability: 'unknown-driver', configuration: { credential: 'secret' } })
    expect(result.configuration).toBeNull()
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.availability).toBe('unknown-driver')
  })
  it('preserves existing recognized defaults and immutable identity readback', () => {
    const configuration = { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }
    const result = projectHarnessInstance({ instanceId: 'local-default:codex', instanceRevision: '3', driverId: 'codex', driverRevision: '1', enabled: true, availability: 'available', configuration })
    expect(result.configuration).toEqual(configuration)
    expect(result.configuration).not.toBe(configuration)
    expect(result.instanceRevision).toBe('3')
  })
})
