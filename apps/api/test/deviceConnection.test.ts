import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceEndpoint, type AuthenticatedDevice } from '../src/modules/devices/deviceEndpoint.js'
import { DeviceConnectionSupervisor } from '../src/modules/devices/connectionSupervisor.js'
import { deviceConnector } from '../src/modules/devices/deviceCarrier.js'
import { adaptDeviceSocket, readFrame, sendFrame, type RawDeviceSocket } from '../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  closed = false
  send(text: string) { this.sent.push(JSON.parse(text)) }
  close() { if (this.closed) return; this.closed = true; this.emit('close') }
  frame(value: unknown) { this.emit('message', JSON.stringify(value), false) }
}
const identity = { mainId: 'main', deviceId: 'device', workerInstallationId: 'install', keyRevision: 1, authorizationRevision: 1, bootId: 'boot' }
const principal: AuthenticatedDevice = { ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }
const hello = { ...identity, connectionEpoch: 'client-epoch', type: 'hello', protocolVersion: 1, appVersion: 'build' }
const welcome = { ...hello, type: 'welcome', connectionEpoch: 'server-epoch', capabilities: { heartbeat: true, dispatch: false, transfer: false } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const makeEndpoint = () => {
  const presence = vi.fn()
  const auth = { authenticateDevice: vi.fn(async () => principal), revalidateDevice: vi.fn(async () => {}) }
  const endpoint = new DeviceEndpoint({ mainId: 'main', appVersion: 'build', auth, reconcile: async () => {}, presence, handshakeMs: 100, heartbeatMs: 100 })
  return { endpoint, auth, presence }
}
afterEach(() => { vi.useRealTimers() })
describe('device-only carrier and lifecycle', () => {
  it.each([{ cookie: 'owner=session' }, { origin: 'https://browser' }, {}])('rejects cookie/browser/missing device authentication %j', async (headers) => {
    const { endpoint, auth } = makeEndpoint(); const socket = new Socket()
    await endpoint.accept(headers, adaptDeviceSocket(socket)); expect(auth.authenticateDevice).not.toHaveBeenCalled(); expect(socket.closed).toBe(true)
  })
  it('negotiates authenticated heartbeat only, then live revocation fences session', async () => {
    const { endpoint, auth, presence } = makeEndpoint(); const socket = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer device-secret' }, adaptDeviceSocket(socket))
    socket.frame(hello); await flush()
    expect(socket.sent[0]).toMatchObject({ type: 'welcome', capabilities: { dispatch: false, transfer: false } })
    socket.frame({ type: 'ping', connectionEpoch: socket.sent[0]!.connectionEpoch }); await flush()
    expect(socket.sent[1]!.type).toBe('pong'); expect(auth.revalidateDevice).toHaveBeenCalledTimes(2)
    endpoint.revoke('device'); await task
    expect(presence.mock.calls.map(([view]) => view.phase)).toEqual(['ready', 'offline'])
  })
  it.each([undefined, 0, 2])('blocks absent/old/new wire protocol %s', async (version) => {
    const { endpoint, presence } = makeEndpoint(); const socket = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket)); socket.frame({ ...hello, protocolVersion: version }); await task
    expect(socket.sent[0]).toEqual({ type: 'blocked', code: 'incompatible-protocol' }); expect(presence).not.toHaveBeenCalled()
  })
  it('blocks the wrong main and expired or revoked credentials', async () => {
    for (const code of ['wrong_main', 'expired', 'revoked']) {
      const { endpoint, auth } = makeEndpoint(); auth.authenticateDevice.mockRejectedValueOnce({ code }); const socket = new Socket()
      await endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket))
      expect(socket.sent[0]!.code).toBe(code === 'wrong_main' ? 'wrong-main' : 'authentication')
    }
  })
  it('replacement fences old presence and handlers', async () => {
    const { endpoint, presence } = makeEndpoint(); const a = new Socket(); const b = new Socket()
    const old = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(a)); a.frame(hello); await flush()
    const fresh = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(b)); b.frame({ ...hello, bootId: 'restart' }); await flush(); await old
    expect(presence.mock.calls.map(([view]) => view.phase)).toEqual(['ready', 'ready'])
    expect(b.sent[0]!.connectionEpoch).not.toBe(a.sent[0]!.connectionEpoch)
    endpoint.close(); await fresh; expect(presence.mock.calls.at(-1)![0].phase).toBe('offline')
  })
  it('main shutdown cancels pending authentication without late presence', async () => {
    const { endpoint, auth, presence } = makeEndpoint(); let resolve!: (value: AuthenticatedDevice) => void
    auth.authenticateDevice.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const socket = new Socket(); const task = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket)); endpoint.close(); await task; resolve(principal); await flush()
    expect(presence).not.toHaveBeenCalled(); expect(socket.closed).toBe(true)
  })
  it('half-open heartbeat expires within declared deadline', async () => {
    vi.useFakeTimers(); const { endpoint, presence } = makeEndpoint(); const socket = new Socket()
    const task = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(socket)); socket.frame(hello); await flush(); await vi.advanceTimersByTimeAsync(101); await task
    expect(socket.closed).toBe(true); expect(presence.mock.calls.at(-1)![0].phase).toBe('offline')
  })
  it('rejects malformed/oversize messages and bounded slow-reader queue', async () => {
    expect(() => readFrame('{')).toThrow('malformed-frame'); expect(() => readFrame(' '.repeat(16_385))).toThrow('malformed-frame')
    const raw = new Socket(); const adapted = adaptDeviceSocket(raw)
    for (let i = 0; i < 33; i++) raw.frame(hello)
    await expect(adapted.messages[Symbol.asyncIterator]().next()).rejects.toThrow('backpressure'); expect(raw.closed).toBe(true)
    const slow = new Socket(); slow.bufferedAmount = 65_536
    expect(() => sendFrame(adaptDeviceSocket(slow), { type: 'ping', connectionEpoch: 'epoch' })).toThrow('backpressure'); slow.close()
  })
  it('supervisor blocks wrong-main without retries and separates stopped state', async () => {
    const socket = new Socket(); const connect = vi.fn(async () => adaptDeviceSocket(socket))
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', connect, reconcile: async () => {} })
    supervisor.start(); await flush(); socket.frame({ ...welcome, mainId: 'different' }); await flush()
    expect(supervisor.status()).toMatchObject({ desired: true, phase: 'blocked', failure: 'wrong-main' }); expect(connect).toHaveBeenCalledTimes(1)
    await supervisor.stop(); expect(supervisor.status()).toMatchObject({ desired: false, phase: 'disconnected' })
  })
  it('cancellation during open closes late sockets and leaves no timers', async () => {
    vi.useFakeTimers(); let resolve!: (value: ReturnType<typeof adaptDeviceSocket>) => void
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', connect: () => new Promise((done) => { resolve = done }), reconcile: async () => {} })
    supervisor.start(); await supervisor.stop(); const socket = new Socket(); resolve(adaptDeviceSocket(socket)); await flush()
    expect(socket.closed).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('transient reconnect gets a fresh generation and reconciles before ready', async () => {
    vi.useFakeTimers(); const sockets: Socket[] = []; const reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', random: () => 0.5, heartbeatMs: 100, connect: async () => { const raw = new Socket(); sockets.push(raw); return adaptDeviceSocket(raw) }, reconcile })
    supervisor.start(); await flush(); sockets[0]!.frame(welcome); await flush(); expect(supervisor.status().phase).toBe('ready')
    sockets[0]!.close(); await vi.advanceTimersByTimeAsync(601); await flush(); sockets[1]!.frame({ ...welcome, connectionEpoch: 'fresh' }); await flush()
    expect(supervisor.status()).toMatchObject({ phase: 'ready', generation: 2 }); expect(reconcile).toHaveBeenCalledTimes(2)
    await supervisor.stop(); expect(vi.getTimerCount()).toBe(0)
  })
  it('requires verified WSS and disables compression', async () => {
    expect(() => deviceConnector({ url: 'ws://main/device/connect', credential: 'secret', create: () => new Socket() as RawDeviceSocket })).toThrow('wrong-main')
    const socket = new Socket(); const create = vi.fn(() => socket); const connect = deviceConnector({ url: 'wss://main/device/connect', credential: 'secret', create })
    const abort = new AbortController(); const task = connect(abort.signal); socket.emit('open'); const adapted = await task
    expect(create.mock.calls[0]).toEqual(['wss://main/device/connect', expect.objectContaining({ rejectUnauthorized: true, perMessageDeflate: false, maxPayload: 16384 })]); adapted.close()
    expect(socket.listenerCount('message')).toBe(0)
  })
})
