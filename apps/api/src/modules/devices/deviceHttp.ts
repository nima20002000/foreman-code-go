import { MainIdentityProofRequestSchema, type MainIdentityProofRequest, type MainSignedIdentityProof } from '@graphql/contracts/device-identity'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEVICE_FRAME_BYTES, DEVICE_PROTOCOL_VERSION } from '@graphql/contracts/device-connection'

/** Separate device-only HTTP listener: never delegates to browser, MCP or full API. */
export function deviceHttpHandler(options: {
  mainId: string; mainPublicKeyFingerprint: string; appVersion: string
  signMainIdentityProof(request: MainIdentityProofRequest): Promise<MainSignedIdentityProof>
  pair(input: { grant: string; requestId: string; mainId: string; workerInstallationId: string; publicKey: string; signature: string }): Promise<unknown>
}) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, body: unknown) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) } }
    if (request.headers.cookie !== undefined || request.headers.origin !== undefined) { reply(401, { error: 'device-authentication-required' }); return }
    if (request.method === 'GET' && request.url === '/device/identity') {
      reply(200, { mainId: options.mainId, mainPublicKeyFingerprint: options.mainPublicKeyFingerprint, protocolVersion: DEVICE_PROTOCOL_VERSION, appVersion: options.appVersion, capabilities: { heartbeat: true, dispatch: false, transfer: false } }); return
    }
    if (request.method !== 'POST' || !['/device/pair', '/device/challenge'].includes(request.url ?? '')) { reply(404, { error: 'not-found' }); return }
    let bytes = 0
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { reply(408, { error: 'pairing-timeout' }); request.destroy() }, 10_000)
    const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed) }
    const failed = () => { cleanup(); reply(400, { error: 'invalid-pairing-request' }) }
    const data = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > DEVICE_FRAME_BYTES) { cleanup(); reply(413, { error: 'pairing-request-too-large' }); request.destroy(); return }
      chunks.push(chunk)
    }
    const end = () => {
      cleanup()
      if (request.url === '/device/challenge') {
        try {
          const proofRequest = MainIdentityProofRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()))
          if (proofRequest.mainId !== options.mainId) { reply(409, { error: 'wrong-main' }); return }
          void options.signMainIdentityProof(proofRequest).then((proof) => reply(200, proof)).catch(() => reply(503, { error: 'main-identity-unavailable' }))
        } catch { reply(400, { error: 'invalid-challenge-request' }) }
        return
      }
      let input: { grant: string; requestId: string; mainId: string; workerInstallationId: string; publicKey: string; signature: string }
      try {
        input = JSON.parse(Buffer.concat(chunks).toString()) as typeof input
        const keys = ['grant', 'requestId', 'mainId', 'workerInstallationId', 'publicKey', 'signature'] as const
        if (!input || keys.some((key) => typeof input[key] !== 'string' || !input[key]) || Object.keys(input).some((key) => !(keys as readonly string[]).includes(key))) throw new Error()
      } catch { reply(400, { error: 'invalid-pairing-request' }); return }
      if (input.mainId !== options.mainId) { reply(409, { error: 'wrong-main' }); return }
      void options.pair(input).then((result) => reply(200, result)).catch(() => reply(401, { error: 'pairing-denied' }))
    }
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed)
  }
}
