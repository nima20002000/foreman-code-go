import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { mainIdentityProofMessage } from '@foreman-code/contracts/device-identity-node'
import { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  closed = false
  sent: Record<string, unknown>[] = []
  send(value: string) { this.sent.push(JSON.parse(value)) }
  frame(value: unknown) { this.emit('message', JSON.stringify(value), false) }
  close() { if (!this.closed) { this.closed = true; this.emit('close') } }
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
function fixture(onBindingLost: (binding: Readonly<DeviceSessionBinding>) => void | Promise<void>,
  reconcile: (binding: DeviceSessionBinding, signal: AbortSignal) => Promise<void> = async () => {}) {
  const identity = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const keys = generateKeyPairSync('ed25519'), mainPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const mainPublicKeyFingerprint = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const endpoint = new DeviceEndpoint({ mainId: identity.mainId, appVersion: 'binding-loss-fixture',
    auth: { authenticateDevice: async () => ({ ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }), revalidateDevice: async () => {} },
    signMainIdentityProof: async request => ({ request, mainApplicationVersion: 'binding-loss-fixture', mainPublicKey, mainPublicKeyFingerprint,
      signature: sign(null, Buffer.from(mainIdentityProofMessage(request, 'binding-loss-fixture')), keys.privateKey).toString('base64url') }),
    reconcile, onBindingLost, presence: () => {}, handshakeMs: 1000, heartbeatMs: 1000 })
  const connect = async (bootId = randomUUID()) => {
    const socket = new Socket(), task = endpoint.accept({ authorization: 'Bearer original-device' }, adaptDeviceSocket(socket))
    socket.frame({ ...identity, type: 'hello', bootId, connectionEpoch: randomUUID(), connectionGeneration: 1,
      protocolVersion: 1, appVersion: 'binding-loss-fixture', nonce: Buffer.alloc(32).toString('base64url'), extensions: [] })
    await flush()
    expect(socket.sent[0]?.type).toBe('welcome')
    socket.frame({ type: 'ready', connectionEpoch: socket.sent[0]!.connectionEpoch })
    await flush()
    return { socket, task }
  }
  return { endpoint, identity, connect }
}

describe('Main original binding-loss callback', () => {
  it('notifies once with the immutable original binding after transport disconnect', async () => {
    const lost = vi.fn(), f = fixture(lost)
    const connection = await f.connect(), original = f.endpoint.currentBinding(f.identity.deviceId)!
    connection.socket.close(); await connection.task
    expect(lost).toHaveBeenCalledExactlyOnceWith(original)
    expect(Object.isFrozen(lost.mock.calls[0]![0])).toBe(true)
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toBeUndefined()
    f.endpoint.close(); await f.endpoint.join()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('revokes the original binding before its replacement becomes current and never closes the replacement from old finally', async () => {
    const lost = vi.fn((binding: Readonly<DeviceSessionBinding>) => {
      expect(f.endpoint.currentBinding(binding.deviceId)).toBeUndefined()
    })
    const f = fixture(lost)
    const old = await f.connect(), original = f.endpoint.currentBinding(f.identity.deviceId)!
    const fresh = await f.connect(); await old.task
    const replacement = f.endpoint.currentBinding(f.identity.deviceId)!
    expect(replacement.connectionEpoch).not.toBe(original.connectionEpoch)
    expect(lost).toHaveBeenCalledExactlyOnceWith(original)
    expect(fresh.socket.closed).toBe(false)
    f.endpoint.close(); await fresh.task; await f.endpoint.join()
    expect(lost.mock.calls.map(([binding]) => binding)).toEqual([original, replacement])
  })

  it.each(['revoke', 'shutdown'] as const)('invokes revocation synchronously during %s', async cause => {
    const lost = vi.fn(), f = fixture(lost), connection = await f.connect()
    const original = f.endpoint.currentBinding(f.identity.deviceId)!
    if (cause === 'revoke') f.endpoint.revoke(f.identity.deviceId, f.identity.authorizationRevision + 1)
    else f.endpoint.close()
    expect(lost).toHaveBeenCalledExactlyOnceWith(original)
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toBeUndefined()
    await connection.task; f.endpoint.close(); await f.endpoint.join()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('joins pending physical domain cleanup instead of treating socket closure as cleanup', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve }), lost = vi.fn(() => pending)
    const f = fixture(lost), connection = await f.connect()
    f.endpoint.close(); await connection.task
    let joined = false
    const drain = f.endpoint.join().then(() => { joined = true })
    await flush(); expect(joined).toBe(false)
    expect(lost).toHaveBeenCalledTimes(1)
    release(); await drain; expect(joined).toBe(true)
  })

  it.each(['throw', 'reject'] as const)('retains a callback %s as a failed drain while still fencing transport', async kind => {
    const failure = new Error('Original writer closure unconfirmed')
    const f = fixture(() => { if (kind === 'throw') throw failure; return Promise.reject(failure) })
    const connection = await f.connect()
    expect(() => f.endpoint.close()).not.toThrow()
    await connection.task
    expect(connection.socket.closed).toBe(true)
    expect(f.endpoint.currentBinding(f.identity.deviceId)).toBeUndefined()
    await expect(f.endpoint.join()).rejects.toMatchObject({ errors: [failure] })
  })

  it('revokes a captured binding during reconciliation and joins both physical callbacks', async () => {
    let reconcileRelease!: () => void, cleanupRelease!: () => void, original: DeviceSessionBinding | undefined
    const reconciliation = new Promise<void>(resolve => { reconcileRelease = resolve })
    const cleanup = new Promise<void>(resolve => { cleanupRelease = resolve })
    const lost = vi.fn(() => cleanup), f = fixture(lost, async binding => { original = binding; await reconciliation })
    const connection = await f.connect()
    expect(original).toBeDefined()
    f.endpoint.close(); await connection.task
    expect(lost).toHaveBeenCalledExactlyOnceWith(original)
    let joined = false
    const drain = f.endpoint.join().then(() => { joined = true })
    reconcileRelease(); await flush(); expect(joined).toBe(false)
    cleanupRelease(); await drain; expect(joined).toBe(true)
  })

  it('does not manufacture a binding for rejected browser authentication', async () => {
    const lost = vi.fn(), f = fixture(lost), socket = new Socket()
    await f.endpoint.accept({ cookie: 'browser-session' }, adaptDeviceSocket(socket))
    expect(socket.closed).toBe(true)
    expect(lost).not.toHaveBeenCalled()
    f.endpoint.close(); await f.endpoint.join()
  })
})
