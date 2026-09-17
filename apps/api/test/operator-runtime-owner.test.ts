import type { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'

interface Driver extends EventEmitter {
  connect: Mock<() => Promise<void>>
  query: Mock<(sql: string) => Promise<{ rows: Array<{ acquired: boolean }> }>>
  end: Mock<() => Promise<void>>
}
const state = vi.hoisted(() => ({ drivers: [] as Driver[] }))
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: { Client: class extends EventEmitter {
    connect = vi.fn<() => Promise<void>>(async () => undefined)
    query = vi.fn<(sql: string) => Promise<{ rows: Array<{ acquired: boolean }> }>>(async () => ({ rows: [{ acquired: true }] }))
    end = vi.fn(async () => { this.emit('end') })
    constructor() { super(); state.drivers.push(this) }
  } } }
})
beforeEach(() => { state.drivers.length = 0 })
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const lost = vi.fn()
  const owner = new OperatorRuntimeOwner('postgresql://fixture/fixture', lost)
  return { owner, lost, driver: state.drivers[0]! }
}

describe('runtime-owner connection lifetime', () => {
  it('does not connect just to close an uninitialized owner', async () => {
    const { owner, driver } = fixture()
    await owner.close()
    expect(driver.connect).not.toHaveBeenCalled()
    expect(driver.query).not.toHaveBeenCalled()
    await expect(owner.acquire()).rejects.toThrow('closing')
  })

  it('coalesces acquire and close and suppresses loss notifications for its own normal end', async () => {
    const { owner, driver, lost } = fixture()
    const first = owner.acquire()
    expect(owner.acquire()).toBe(first)
    await first
    const closing = owner.close()
    expect(owner.close()).toBe(closing)
    await closing
    expect(driver.connect).toHaveBeenCalledTimes(1)
    expect(driver.query).toHaveBeenCalledTimes(2)
    expect(driver.end).toHaveBeenCalledTimes(1)
    expect(lost).not.toHaveBeenCalled()
  })

  it('ends a rejected acquisition exactly once and never reports ownership loss', async () => {
    const { owner, driver, lost } = fixture()
    driver.query.mockResolvedValue({ rows: [{ acquired: false }] })
    await expect(owner.acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
    await owner.close()
    expect(driver.end).toHaveBeenCalledTimes(1)
    expect(lost).not.toHaveBeenCalled()
  })

  it('waits for a pending lock query before closing and releases a late-acquired lock', async () => {
    const { owner, driver } = fixture()
    const pending = gate(); const entered = gate()
    driver.query.mockImplementationOnce(async () => { entered.resolve(); await pending.promise; return { rows: [{ acquired: true }] } })
    const acquiring = owner.acquire()
    await entered.promise
    const closing = owner.close()
    expect(driver.end).not.toHaveBeenCalled()
    pending.resolve()
    await Promise.all([acquiring, closing])
    expect(driver.query.mock.calls.map(([sql]) => sql)).toEqual([
      'select pg_try_advisory_lock($1) as acquired', 'select pg_advisory_unlock($1)',
    ])
    expect(driver.end).toHaveBeenCalledTimes(1)
  })

  for (const event of ['error', 'end'] as const) {
    it(`reports unexpected ${event} once and never reuses the lost connection`, async () => {
      const { owner, driver, lost } = fixture()
      await owner.acquire()
      driver.emit(event, new Error('lost connection'))
      driver.emit('error', new Error('duplicate loss'))
      expect(lost).toHaveBeenCalledTimes(1)
      await expect(owner.acquire()).rejects.toBeInstanceOf(Error)
      await owner.close()
      expect(lost).toHaveBeenCalledTimes(1)
    })
  }

  it('preserves unlock errors instead of reporting successful release', async () => {
    const { owner, driver } = fixture()
    await owner.acquire()
    const failure = new Error('unlock failed')
    driver.query.mockRejectedValueOnce(failure)
    await expect(owner.close()).rejects.toBe(failure)
    await expect(owner.close()).rejects.toBe(failure)
    expect(driver.end).toHaveBeenCalledTimes(1)
  })
})
