import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { DEVICE_PROTOCOL_VERSION, DeviceSessionBindingSchema,
  type DeviceHello, type DeviceWelcome } from '@foreman-code/contracts/device-connection'
import { MainIdentityProofRequestSchema, MainSignedIdentityProofSchema,
  WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { mainIdentityProofMessage, publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { createDeviceTls } from '../harnesses/tls.js'
import { connectTestWorker } from './workerConnection.js'
import { withWorkerDeadline } from './workerDeferred.js'

const cleanups: Array<() => Promise<void>> = []

/** Fresh protocol peer for this client regression; no product instance, database,
 * installed worker, provider or application qualification is used. */
async function signedPeer() {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-worker-close-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const tls = await createDeviceTls(join(directory, 'tls'), {
    PATH: process.env.PATH, HOME: directory, LANG: 'C.UTF-8',
  })
  const key = generateKeyPairSync('ed25519')
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const fingerprint = publicKeyFingerprint(publicKey)
  const credential = randomBytes(32).toString('hex')
  const server = createServer({ cert: await readFile(tls.certificate), key: await readFile(tls.privateKey) })
  const sockets = new WebSocketServer({ server, path: '/device/connect', perMessageDeflate: false,
    verifyClient: info => info.req.headers.authorization === `Bearer ${credential}` })
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => sockets.close(error => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const peers: WebSocket[] = []
  const faults: unknown[] = []
  sockets.on('connection', socket => {
    peers.push(socket)
    socket.on('message', bytes => {
      try {
        const frame = JSON.parse(String(bytes)) as DeviceHello | { type: 'ready' | 'ping'; connectionEpoch: string }
        if (frame.type === 'hello') {
          const binding = DeviceSessionBindingSchema.strip().parse({ ...frame, connectionEpoch: randomUUID() })
          const request = MainIdentityProofRequestSchema.parse({ audience: 'graphql-worker-main-v1', ...binding,
            nonce: frame.nonce, connectionEpoch: frame.connectionEpoch, mainConnectionEpoch: binding.connectionEpoch,
            protocolVersion: DEVICE_PROTOCOL_VERSION, workerApplicationVersion: frame.appVersion,
            negotiationHash: createHash('sha256').update(JSON.stringify([])).digest('hex') })
          const mainApplicationVersion = 'owned-protocol-peer'
          const proof = MainSignedIdentityProofSchema.parse({ request, mainApplicationVersion,
            mainPublicKey: publicKey, mainPublicKeyFingerprint: fingerprint,
            signature: sign(null, Buffer.from(mainIdentityProofMessage(request, mainApplicationVersion)), key.privateKey).toString('base64url') })
          const welcome: DeviceWelcome = { type: 'welcome', ...binding, protocolVersion: DEVICE_PROTOCOL_VERSION,
            appVersion: mainApplicationVersion, mainIdentityProof: proof,
            capabilities: { heartbeat: true, dispatch: false, transfer: false, extensions: [] } }
          socket.send(JSON.stringify(welcome))
        } else if (frame.type === 'ready' || frame.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', connectionEpoch: frame.connectionEpoch, mainReady: true }))
        }
      } catch (error) { faults.push(error); socket.terminate() }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The isolated peer did not select a random TCP port.')
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1,
    mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, endpoint: `wss://127.0.0.1:${address.port}/device/connect`,
    mainPublicKeyFingerprint: fingerprint, tlsTrust: tls.trust, credential,
    expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const client = await connectTestWorker({ pairing })
  let closed = false
  cleanups.push(async () => { if (!closed) await client.close() })
  const close = async () => { closed = true; await client.close() }
  const peer = peers[0]
  if (!peer) throw new Error('The isolated worker did not establish its real TLS connection.')
  return { peer, client, close, faults }
}

describe('worker cleanup retains transport errors', () => {
  afterEach(async () => {
    const failures: unknown[] = []
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned peer cleanup failed.')
  })

  it('reports a malformed frame even after its socket closed before scenario cleanup', async () => {
    const fixture = await signedPeer()
    expect(fixture.client.currentBinding().mainId).toBeTruthy()
    const disconnected = once(fixture.peer, 'close')
    fixture.peer.send('{not-json')
    await withWorkerDeadline(disconnected)
    await expect(fixture.close()).rejects.toBeInstanceOf(SyntaxError)
    expect(fixture.faults).toEqual([])
  }, 30_000)

  it('does not reclassify an explicitly requested normal close as a protocol failure', async () => {
    const fixture = await signedPeer()
    const disconnected = once(fixture.peer, 'close')
    await expect(fixture.close()).resolves.toBeUndefined()
    await withWorkerDeadline(disconnected)
    expect(fixture.faults).toEqual([])
  }, 30_000)
})
