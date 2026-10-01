import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mainIdentityProofMessage } from '@graphql/contracts/device-identity-node'
import type { MainIdentityProofRequest } from '@graphql/contracts/device-identity'
import WebSocket, { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceHttpHandler } from '../src/modules/devices/deviceHttp.js'
import { DeviceEndpoint, type AuthenticatedDevice } from '../src/modules/devices/deviceEndpoint.js'
import { DeviceConnectionSupervisor } from '../src/modules/devices/connectionSupervisor.js'
import { deviceConnector, deviceUpgradeHandler } from '../src/modules/devices/deviceCarrier.js'
import { adaptDeviceSocket, readFrame, sendFrame } from '../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  closed = false
  send(text: string) { this.sent.push(JSON.parse(text)) }
  close() { if (this.closed) return; this.closed = true; this.emit('close') }
  frame(value: unknown) { this.emit('message', JSON.stringify(value), false) }
}
const identity = { mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222', workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1, bootId: '44444444-4444-4444-8444-444444444444' }
const mainKeys = generateKeyPairSync('ed25519')
const mainPublicKey = mainKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const fingerprint = createHash('sha256').update(mainKeys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const proof = async (request: MainIdentityProofRequest) => ({ request, mainApplicationVersion: 'build', mainPublicKey, mainPublicKeyFingerprint: fingerprint, signature: sign(null, Buffer.from(mainIdentityProofMessage(request, 'build')), mainKeys.privateKey).toString('base64url') })
const principal: AuthenticatedDevice = { ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }
const hello = { ...identity, connectionEpoch: '55555555-5555-4555-8555-555555555555', type: 'hello', protocolVersion: 1, appVersion: 'build', nonce: Buffer.alloc(32).toString('base64url'), connectionGeneration: 1 }
const welcome = { ...hello, type: 'welcome', connectionEpoch: '66666666-6666-4666-8666-666666666666', capabilities: { heartbeat: true, dispatch: false, transfer: false } }
const signedWelcome = async (sent: Record<string, unknown>, epoch = welcome.connectionEpoch) => ({ ...welcome, connectionEpoch: epoch, mainIdentityProof: await proof({ audience: 'graphql-worker-main-v1', ...identity, nonce: sent.nonce as string, connectionGeneration: sent.connectionGeneration as number, connectionEpoch: sent.connectionEpoch as string, mainConnectionEpoch: epoch, protocolVersion: 1, workerApplicationVersion: 'build' }) })
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const makeEndpoint = () => {
  const presence = vi.fn()
  const auth = { authenticateDevice: vi.fn(async () => principal), revalidateDevice: vi.fn(async () => {}) }
  const endpoint = new DeviceEndpoint({ mainId: identity.mainId, appVersion: 'build', signMainIdentityProof: proof, auth, reconcile: async () => {}, presence, handshakeMs: 100, heartbeatMs: 100 })
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
    endpoint.revoke(identity.deviceId); await task
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
    const fresh = endpoint.accept({ authorization: 'Bearer secret' }, adaptDeviceSocket(b)); b.frame({ ...hello, bootId: '77777777-7777-4777-8777-777777777777' }); await flush(); await old
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
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect, reconcile: async () => {} })
    supervisor.start(); await flush(); socket.frame({ ...welcome, mainId: 'different' }); await flush()
    expect(supervisor.status()).toMatchObject({ desired: true, phase: 'blocked', failure: 'wrong-main' }); expect(connect).toHaveBeenCalledTimes(1)
    await supervisor.stop(); expect(supervisor.status()).toMatchObject({ desired: false, phase: 'disconnected' })
  })
  it.each(['missing', 'nonce', 'boot', 'generation', 'epoch', 'auth', 'key', 'signature', 'fingerprint'])('blocks tampered or absent selected-main proof: %s', async (field) => {
    const socket = new Socket(); const reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect: async () => adaptDeviceSocket(socket), reconcile })
    supervisor.start(); await flush()
    const response = await signedWelcome(socket.sent[0]!)
    const altered = response as unknown as { mainIdentityProof?: { request: Record<string, unknown>; signature: string; mainPublicKeyFingerprint: string } }
    if (field === 'missing') delete altered.mainIdentityProof
    else if (field === 'signature') altered.mainIdentityProof!.signature = 'A'.repeat(86)
    else if (field === 'fingerprint') altered.mainIdentityProof!.mainPublicKeyFingerprint = 'a'.repeat(64)
    else { const key = { nonce: 'nonce', boot: 'bootId', generation: 'connectionGeneration', epoch: 'mainConnectionEpoch', auth: 'authorizationRevision', key: 'keyRevision' }[field]!; altered.mainIdentityProof!.request[key] = field === 'nonce' ? 'a'.repeat(43) : field === 'boot' || field === 'epoch' ? '99999999-9999-4999-8999-999999999999' : 99 }
    socket.frame(response); await flush()
    expect(supervisor.status()).toMatchObject({ phase: 'blocked', failure: 'wrong-main' }); expect(reconcile).not.toHaveBeenCalled(); await supervisor.stop()
  })
  it('cancellation during open closes late sockets and leaves no timers', async () => {
    vi.useFakeTimers(); let resolve!: (value: ReturnType<typeof adaptDeviceSocket>) => void
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, connect: () => new Promise((done) => { resolve = done }), reconcile: async () => {} })
    supervisor.start(); await supervisor.stop(); const socket = new Socket(); resolve(adaptDeviceSocket(socket)); await flush()
    expect(socket.closed).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('transient reconnect gets a fresh generation and reconciles before ready', async () => {
    vi.useFakeTimers(); const sockets: Socket[] = []; const reconcile = vi.fn(async () => {})
    const supervisor = new DeviceConnectionSupervisor({ identity, appVersion: 'build', mainPublicKeyFingerprint: fingerprint, random: () => 0.5, heartbeatMs: 100, connect: async () => { const raw = new Socket(); sockets.push(raw); return adaptDeviceSocket(raw) }, reconcile })
    supervisor.start(); await flush(); sockets[0]!.frame(await signedWelcome(sockets[0]!.sent[0]!)); await flush(); expect(supervisor.status().phase).toBe('ready')
    sockets[0]!.close(); await vi.advanceTimersByTimeAsync(601); await flush(); sockets[1]!.frame(await signedWelcome(sockets[1]!.sent[0]!, '88888888-8888-4888-8888-888888888888')); await flush()
    expect(supervisor.status()).toMatchObject({ phase: 'ready', generation: 2 }); expect(reconcile).toHaveBeenCalledTimes(2)
    await supervisor.stop(); expect(vi.getTimerCount()).toBe(0)
  })
  it('requires verified WSS and disables compression', async () => {
    expect(() => deviceConnector({ url: 'ws://main/device/connect', credential: 'secret', create: () => new Socket() })).toThrow('wrong-main')
    const socket = new Socket(); const create = vi.fn(() => socket); const connect = deviceConnector({ url: 'wss://main/device/connect', credential: 'secret', create })
    const abort = new AbortController(); const task = connect(abort.signal); socket.emit('open'); const adapted = await task
    expect(create.mock.calls[0]).toEqual(['wss://main/device/connect', expect.objectContaining({ rejectUnauthorized: true, perMessageDeflate: false, maxPayload: 16384 })]); adapted.close()
    expect(socket.listenerCount('message')).toBe(0)
  })
})


describe('pinned ws adapter on disposable loopback transport', () => {
  it('authenticates before upgrade and negotiates real bounded ws frames', async () => {
    const { endpoint, presence } = makeEndpoint()
    const server = createServer((_request, response) => { response.writeHead(404); response.end() })
    const carrier = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
    server.on('upgrade', deviceUpgradeHandler(endpoint, carrier))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing loopback address')
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/device/connect`, { headers: { Authorization: 'Bearer device' }, perMessageDeflate: false })
    try {
      await once(client, 'open')
      const welcomeMessage = once(client, 'message'); client.send(JSON.stringify(hello))
      const [received] = await welcomeMessage; const negotiated = JSON.parse(String(received))
      expect(negotiated).toMatchObject({ type: 'welcome', capabilities: { dispatch: false, transfer: false } })
      expect(client.extensions).toBe('')
      const pong = once(client, 'message'); client.send(JSON.stringify({ type: 'ping', connectionEpoch: negotiated.connectionEpoch }))
      expect(JSON.parse(String((await pong)[0]))).toEqual({ type: 'pong', connectionEpoch: negotiated.connectionEpoch })
      const closed = once(client, 'close'); endpoint.revoke(identity.deviceId); await closed
      await flush(); expect(presence.mock.calls.at(-1)![0].phase).toBe('offline')
    } finally {
      endpoint.close(); client.terminate(); carrier.close(); await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('maps pre-upgrade rejection into blocked auth without a retry storm', async () => {
    const { endpoint, auth } = makeEndpoint(); auth.authenticateDevice.mockRejectedValue({ code: 'revoked' })
    const server = createServer(); const carrier = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
    server.on('upgrade', deviceUpgradeHandler(endpoint, carrier)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
    // URL validation uses WSS; the injected constructor below uses disposable HTTP solely for this transport test.
    const connect = deviceConnector({ url: 'wss://main/device/connect', credential: 'revoked', create: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}/device/connect`, options) })
    try { await expect(connect(new AbortController().signal)).rejects.toThrow('authentication') }
    finally { endpoint.close(); carrier.close(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})


describe('device-only HTTP bootstrap', () => {
  it('returns selected-main descriptor and bounded signed pairing only', async () => {
    const pair = vi.fn(async () => ({ credential: 'device-only' }))
    const server = createServer(deviceHttpHandler({ mainId: identity.mainId, mainPublicKeyFingerprint: fingerprint, appVersion: 'build', pair, signMainIdentityProof: proof }))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const descriptor = await fetch(`${base}/device/identity`)
      expect(await descriptor.json()).toMatchObject({ mainId: identity.mainId, mainPublicKeyFingerprint: fingerprint, capabilities: { dispatch: false } })
      expect((await fetch(`${base}/device/identity`, { headers: { Cookie: 'owner=secret' } })).status).toBe(401)
      const input = { grant: 'grant', requestId: 'request', mainId: identity.mainId, workerInstallationId: identity.workerInstallationId, publicKey: 'public', signature: 'signature' }
      const challengeRequest: MainIdentityProofRequest = { audience: 'graphql-worker-main-v1', mainId: identity.mainId, workerInstallationId: identity.workerInstallationId, nonce: hello.nonce, protocolVersion: 1, workerApplicationVersion: 'build' }
      const challenge = await fetch(`${base}/device/challenge`, { method: 'POST', body: JSON.stringify(challengeRequest) })
      expect(challenge.status).toBe(200); expect(await challenge.json()).toMatchObject({ request: challengeRequest, mainPublicKeyFingerprint: fingerprint })
      const paired = await fetch(`${base}/device/pair`, { method: 'POST', body: JSON.stringify(input) })
      expect(paired.status).toBe(200); expect(pair).toHaveBeenCalledWith(input)
      expect((await fetch(`${base}/device/pair`, { method: 'POST', body: JSON.stringify({ ...input, mainId: 'wrong' }) })).status).toBe(409)
      expect((await fetch(`${base}/device/pair`, { method: 'POST', body: '{' })).status).toBe(400)
      expect((await fetch(`${base}/management`, { method: 'POST' })).status).toBe(404)
      expect(pair).toHaveBeenCalledTimes(1)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
