import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ComputerDriveService } from './drive.js'
import { DomainError } from '../errors.js'

const binding = vi.hoisted(() => ({ check: vi.fn(async () => {}) }))
vi.mock('./github.js', () => ({ assertCurrentComputer: binding.check }))
const mainId = '11111111-1111-4111-8111-111111111111'
const target: DeviceProvisioningTarget = { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }
const worker: DeviceProvisioningTarget = { hostRef: { kind: 'device', mainId, deviceId: '22222222-2222-4222-8222-222222222222' },
  applicationInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1 }
const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z',
  revokedAt: null, grants: [{ actions: ['settings:update'], scope: {} }] }
const token = '{"access_token":"a","refresh_token":"r"}'
const state = (connected = false) => ({ installed: true, connected, mounted: connected, account: connected ? 'owner@gmail.com' : null,
  mountPath: connected ? '/home/u/Foreman Code Drive' : null, message: null })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture() {
  const handle = vi.fn(async (request: { operation: string }) => state(request.operation === 'connect'))
  const commands = { recordAudit: vi.fn(async () => {}), recordDenied: vi.fn(async () => {}) }
  const changed = vi.fn()
  let now = Date.now()
  const service = new ComputerDriveService({} as pg.Pool, mainId, () => ({
    capabilities: () => [{ namespace: 'computer-drive-v2', mainCanRequest: true }],
    request: async (_device, _namespace, request) => ({ payload: await handle(request as { operation: string }) }),
  }), commands as unknown as PostgresCommandCoordinator, { local: { handle }, now: () => now, changed })
  return { service, handle, changed, commands, advance: () => { now += 11 * 60_000 } }
}
beforeEach(() => binding.check.mockReset().mockResolvedValue(undefined))

describe('Drive connection sessions', () => {
  it('offers browser-side remote authorization and preserves simultaneous sign-ins on different computers', async () => {
    const f = fixture()
    const a = await f.service.connectStart(owner, 'http', target)
    const b = await f.service.connectStart(owner, 'mcp', worker)
    expect(a.authorizationUrl).toBeNull()
    expect(a.authorizationCommand).toMatch(/^rclone authorize drive /u)
    expect(await f.service.connectStatus(owner, 'http', target, a.loginId!)).toMatchObject({ state: 'waiting' })
    expect(await f.service.connectComplete(owner, 'mcp', worker, b.loginId!, token)).toMatchObject({ state: 'connected' })
    expect(await f.service.connectComplete(owner, 'http', target, a.loginId!, token)).toMatchObject({ state: 'connected' })
  })

  it('invalidates unfinished authorization on disconnect and never applies its later token', async () => {
    const f = fixture()
    const start = await f.service.connectStart(owner, 'http', target)
    await f.service.disconnect(owner, 'http', target)
    await expect(f.service.connectComplete(owner, 'http', target, start.loginId!, token))
      .rejects.toMatchObject({ code: 'DRIVE_LOGIN_INACTIVE' })
    expect(await f.service.connectStatus(owner, 'http', target, start.loginId!)).toMatchObject({ state: 'cancelled' })
    expect(f.handle.mock.calls.map(([request]) => request.operation)).toEqual(['intent', 'install', 'intent', 'disconnect'])
  })

  it('keeps a newer session when an older setup fails late', async () => {
    const f = fixture()
    const install = deferred<ReturnType<typeof state>>()
    f.handle.mockImplementationOnce(() => install.promise)
    const old = f.service.connectStart(owner, 'http', target)
    const rejected = expect(old).rejects.toThrow('old setup failed')
    await vi.waitFor(() => expect(f.handle).toHaveBeenCalledOnce())
    const fresh = await f.service.connectStart(owner, 'http', target)
    install.reject(new Error('old setup failed'))
    await rejected
    expect(await f.service.connectStatus(owner, 'http', target, fresh.loginId!)).toMatchObject({ state: 'waiting' })
    expect(await f.service.connectComplete(owner, 'http', target, fresh.loginId!, token)).toMatchObject({ state: 'connected' })
  })

  it('serializes first-time folder creation across computers and lets disconnect finish after an in-flight mount', async () => {
    const f = fixture()
    const a = await f.service.connectStart(owner, 'http', target)
    const b = await f.service.connectStart(owner, 'http', worker)
    const mount = deferred<ReturnType<typeof state>>()
    f.handle.mockImplementationOnce(() => mount.promise)
    const first = f.service.connectComplete(owner, 'http', target, a.loginId!, token)
    await vi.waitFor(() => expect(f.handle).toHaveBeenCalledTimes(5))
    const second = f.service.connectComplete(owner, 'http', worker, b.loginId!, token)
    const disconnect = f.service.disconnect(owner, 'http', target)
    await vi.waitFor(() => expect(binding.check).toHaveBeenCalledTimes(6))
    expect(f.handle.mock.calls.filter(([request]) => request.operation === 'connect')).toHaveLength(1)
    mount.resolve(state(true))
    expect(await first).toMatchObject({ state: 'cancelled' })
    expect(await second).toMatchObject({ state: 'connected' })
    expect(await disconnect).toMatchObject({ state: 'disconnected' })
    expect(f.handle.mock.calls.map(([request]) => request.operation)).toEqual(['intent', 'install', 'intent', 'install', 'connect', 'intent', 'connect', 'disconnect'])
  })

  it('expires old authorization and reports missing sessions', async () => {
    const f = fixture()
    const start = await f.service.connectStart(owner, 'http', target)
    f.advance()
    expect(await f.service.connectStatus(owner, 'http', target, start.loginId!)).toMatchObject({ state: 'expired' })
    await expect(f.service.connectComplete(owner, 'http', target, start.loginId!, token))
      .rejects.toMatchObject({ code: 'DRIVE_LOGIN_INACTIVE' })
    await expect(f.service.connectStatus(owner, 'http', target, mainId)).rejects.toMatchObject({ code: 'DRIVE_LOGIN_NOT_FOUND' })
  })

  it('rechecks pairing and permissions before accepting the authorization and invalidates accounts after mutations', async () => {
    const f = fixture()
    const start = await f.service.connectStart(owner, 'http', worker)
    binding.check.mockRejectedValueOnce(new DomainError('COMPUTER_NOT_FOUND', 'Registration changed.', 404))
    await expect(f.service.connectComplete(owner, 'http', worker, start.loginId!, token)).rejects.toMatchObject({ code: 'COMPUTER_NOT_FOUND' })
    expect(f.handle.mock.calls.map(([request]) => request.operation)).toEqual(['intent', 'install'])
    await f.service.connectComplete(owner, 'http', worker, start.loginId!, token)
    await f.service.disconnect(owner, 'http', worker)
    expect(f.changed.mock.calls).toEqual([[worker], [worker]])
  })
})


it.each(['disconnect-first', 'start-first'])('preserves a newer sign-in when %s resolves after overlapping requests', async order => {
  const f = fixture()
  const stop = deferred<ReturnType<typeof state>>()
  const install = deferred<ReturnType<typeof state>>()
  f.handle.mockImplementation(request => {
    if (request.operation === 'disconnect') return stop.promise
    if (request.operation === 'install') return install.promise
    return Promise.resolve(state())
  })
  const disconnecting = f.service.disconnect(owner, 'http', target)
  await vi.waitFor(() => expect(f.handle.mock.calls.some(([request]) => request.operation === 'disconnect')).toBe(true))
  const starting = f.service.connectStart(owner, 'http', target)
  await vi.waitFor(() => expect(f.handle.mock.calls.some(([request]) => request.operation === 'install')).toBe(true))
  if (order === 'disconnect-first') {
    stop.resolve(state())
    expect(await disconnecting).toMatchObject({ state: 'cancelled' })
    install.resolve(state())
  } else {
    install.resolve(state())
    await starting
    stop.resolve(state())
  }
  const latest = await starting
  await disconnecting
  expect(await f.service.connectStatus(owner, 'http', target, latest.loginId!)).toMatchObject({ state: 'waiting' })
})

it('does not let an earlier request with delayed authorization replace a newer intent', async () => {
  const f = fixture()
  const authorization = deferred<void>()
  binding.check.mockImplementationOnce(() => authorization.promise)
  const older = f.service.disconnect(owner, 'http', target)
  const newer = await f.service.connectStart(owner, 'http', target)
  authorization.resolve()
  expect(await older).toMatchObject({ state: 'cancelled' })
  expect(f.handle.mock.calls.map(([request]) => request.operation)).toEqual(['intent', 'install'])
  expect(await f.service.connectStatus(owner, 'http', target, newer.loginId!)).toMatchObject({ state: 'waiting' })
})

it('cancels sign-in through its target generation while preserving another computer session', async () => {
  const f = fixture()
  const a = await f.service.connectStart(owner, 'mcp', target)
  const b = await f.service.connectStart(owner, 'mcp', worker)
  expect(await f.service.cancel(owner, 'mcp', target, a.loginId!)).toMatchObject({ state: 'cancelled' })
  await expect(f.service.connectComplete(owner, 'mcp', target, a.loginId!, token)).rejects.toMatchObject({ code: 'DRIVE_LOGIN_INACTIVE' })
  expect(await f.service.connectStatus(owner, 'mcp', worker, b.loginId!)).toMatchObject({ state: 'waiting' })
})
