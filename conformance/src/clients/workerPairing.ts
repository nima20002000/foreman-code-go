import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import {
  DevicePairingGrantInputSchema, DevicePairingGrantResultSchema, DevicePairingRequestSchema,
  DevicePairingResultSchema, MainDeviceIdentityPublicSchema, MainEnrollmentProofRequestSchema,
  WorkerPairingConfigurationSchema, type DeviceTlsTrust,
} from '@foreman-code/contracts/device-identity'
import { pairingProof, publicKeyFingerprint, verifyMainEnrollmentProof,
  type WorkerLocalIdentity } from '@foreman-code/contracts/device-identity-node'
import { DEVICE_PROTOCOL_VERSION } from '@foreman-code/contracts/device-connection'
import { deviceTlsOptions } from '@foreman-code/contracts/device-tls-node'

export interface PairTestWorkerOptions {
  baseUrl: string
  headers?: HeadersInit
  managementRequest?(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }>
  deviceEndpoint: string
  deviceTlsTrust: DeviceTlsTrust
  appVersion?: string
  signal?: AbortSignal
}

export class WorkerHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`The isolated worker endpoint returned HTTP ${status}.`)
  }
}

function requireLoopback(url: URL) {
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error('A conformance worker may contact only the fresh loopback target.')
  }
}

async function managementRequest(options: PairTestWorkerOptions, path: string, body?: unknown) {
  if (options.managementRequest) {
    const response = await options.managementRequest(body === undefined ? 'GET' : 'POST', path, body)
    if (response.status < 200 || response.status >= 300) throw new WorkerHttpError(response.status, response.body)
    return response.body
  }
  const url = new URL(path, options.baseUrl)
  requireLoopback(url)
  const headers = new Headers(options.headers)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: options.signal ?? AbortSignal.timeout(15_000) })
  const value: unknown = await response.json()
  if (!response.ok) throw new WorkerHttpError(response.status, value)
  return value
}

/** Uses the same selected-CA validation as the installed worker. */
export async function deviceRequest(options: Pick<PairTestWorkerOptions, 'deviceEndpoint' | 'deviceTlsTrust' | 'signal'>,
  path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path, options.deviceEndpoint)
  requireLoopback(url)
  if (url.protocol !== 'wss:') throw new Error('The device fixture requires a verified TLS listener.')
  url.protocol = 'https:'
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ...deviceTlsOptions(options.deviceTlsTrust),
      method: bytes ? 'POST' : 'GET', signal: options.signal ?? AbortSignal.timeout(15_000),
      headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.byteLength } : {},
    }, response => {
      const chunks: Buffer[] = []
      let length = 0
      response.on('error', reject)
      response.on('data', (chunk: Buffer) => {
        length += chunk.byteLength
        if (length > 1_048_576) { response.destroy(new Error('Worker HTTP response exceeded its fixture bound.')); return }
        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) reject(new WorkerHttpError(status, value))
          else resolve(value)
        } catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
    request.end(bytes)
  })
}

/** Fresh Ed25519 keys and the application's existing pairing grant flow. */
export async function pairTestWorker(options: PairTestWorkerOptions) {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity: WorkerLocalIdentity = { formatVersion: 1, workerInstallationId: randomUUID(), keyRevision: 1,
    publicKey, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: publicKeyFingerprint(publicKey) }
  const main = MainDeviceIdentityPublicSchema.parse(await managementRequest(options, '/api/devices/main'))
  const input = DevicePairingGrantInputSchema.parse({ workerInstallationId: identity.workerInstallationId,
    publicKey: identity.publicKey, expectedFingerprint: identity.publicKeyFingerprint,
    scopes: ['connect', 'heartbeat', 'metrics:report'], commandId: randomUUID() })
  const grant = DevicePairingGrantResultSchema.parse(await managementRequest(options, '/api/devices/pairing-grants', input))
  const proofRequest = MainEnrollmentProofRequestSchema.parse({ audience: 'graphql-worker-main-enrollment-v1',
    mainId: main.mainId, nonce: randomBytes(32).toString('base64url'), workerInstallationId: identity.workerInstallationId,
    protocolVersion: DEVICE_PROTOCOL_VERSION, workerApplicationVersion: options.appVersion ?? 'conformance-fixture' })
  const proof = await deviceRequest(options, '/device/challenge', proofRequest)
  if (!await verifyMainEnrollmentProof(proof, proofRequest, main.mainPublicKeyFingerprint)) {
    throw new Error('Fresh worker enrollment did not prove the selected main identity.')
  }
  const unsigned = { mainId: main.mainId, workerInstallationId: identity.workerInstallationId,
    publicKey: identity.publicKey, grant: grant.grant, requestId: randomUUID() }
  const request = DevicePairingRequestSchema.parse({ ...unsigned,
    signature: sign(null, Buffer.from(pairingProof(unsigned)), keys.privateKey).toString('base64url') })
  const paired = DevicePairingResultSchema.parse(await deviceRequest(options, '/device/pair', request))
  const registration = paired.registration
  if (registration.mainId !== main.mainId || registration.deviceId !== grant.registration.deviceId
    || registration.workerInstallationId !== identity.workerInstallationId
    || registration.publicKeyFingerprint !== identity.publicKeyFingerprint || registration.status !== 'paired') {
    throw new Error('The pairing response changed the approved fresh worker identity.')
  }
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1,
    mainId: registration.mainId, deviceId: registration.deviceId, workerInstallationId: identity.workerInstallationId,
    keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision,
    endpoint: options.deviceEndpoint, mainPublicKeyFingerprint: main.mainPublicKeyFingerprint,
    tlsTrust: options.deviceTlsTrust, credential: paired.credential, expiresAt: paired.expiresAt })
  return { identity, pairing, registration }
}
