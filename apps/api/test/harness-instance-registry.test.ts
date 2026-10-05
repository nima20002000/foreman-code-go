import { describe, expect, it } from 'vitest'
import { HarnessInstanceRegistry } from '../src/modules/harnesses/instanceRegistry.js'

describe('configured harness instances', () => {
  it('decodes once and pins independent immutable revisions without live resources', () => {
    let decodes = 0
    const registry = new HarnessInstanceRegistry([{ driverId: 'test', driverRevision: '1', decodeConfiguration(value) { decodes++; return value } }])
    const a = { instanceId: 'a', instanceRevision: '1', driverId: 'test', enabled: true, configuration: { model: 'old' } }
    const b = { ...a, instanceId: 'b' }
    registry.reload([a, b])
    const pinned = registry.select('a')
    expect(registry.select('a')).toBe(pinned)
    expect(decodes).toBe(2)
    registry.reload([{ ...a, instanceRevision: '2', configuration: { model: 'new' } }, b])
    expect(pinned.configuration).toEqual({ model: 'old' })
    expect(Object.isFrozen(pinned.configuration)).toBe(true)
    expect(registry.select('b').configuration).toEqual({ model: 'old' })
    expect(() => registry.reload([{ ...a, instanceRevision: '2' }])).toThrow('immutable')
  })
  it('keeps unknown, invalid and disabled instances visible and fails closed', () => {
    const registry = new HarnessInstanceRegistry([{ driverId: 'bad', driverRevision: '1', decodeConfiguration() { throw new Error('invalid') } }])
    registry.reload(['unknown', 'bad'].map((driverId) => ({ instanceId: driverId, instanceRevision: '1', driverId, configuration: {}, enabled: true })).concat([{ instanceId: 'disabled', instanceRevision: '1', driverId: 'bad', configuration: {}, enabled: false }]))
    expect(registry.list().map((value) => value.availability)).toEqual(['unknown-driver', 'invalid-configuration', 'disabled'])
    for (const id of ['unknown', 'bad', 'disabled', 'missing']) expect(() => registry.select(id)).toThrow('unavailable')
    for (const id of ['unknown', 'bad', 'disabled']) {
      expect(() => registry.select(id)).toThrow(expect.objectContaining({ code: 'HARNESS_INSTANCE_INVALID', status: 409 }))
    }
    expect(() => registry.select('missing')).toThrow(expect.objectContaining({ code: 'HARNESS_INSTANCE_UNAVAILABLE', status: 503 }))
  })
})
