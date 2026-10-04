import { X509Certificate, createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { Socket } from 'node:net'
import { WebSocketServer } from 'ws'
import { DEVICE_FRAME_BYTES } from '@foreman-code/contracts/device-connection'
import { deviceUpgradeHandler } from './deviceCarrier.js'
import type { DeviceEndpoint } from './deviceEndpoint.js'
import { deviceHttpHandler } from './deviceHttp.js'
import type { DeviceListenerConfig } from './productionConfig.js'

/** One explicitly opted-in device-only TLS listener. It has no browser, API or
 * MCP delegation, certificate fallback, provider login or owner credentials. */
export class ProductionDeviceListener {
  private server: Server | undefined
  private websocket: WebSocketServer | undefined
  private readonly sockets = new Set<Socket>()
  private closing = false
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private publicTrust: import('@foreman-code/contracts/device-identity').DeviceTlsTrust | undefined
  publicTlsTrust() { return this.publicTrust ? { ...this.publicTrust } : undefined }
  private serverClosed = false
  private websocketClosed = false
  constructor(private readonly config: DeviceListenerConfig, private readonly endpoint: DeviceEndpoint,
    private readonly http: Parameters<typeof deviceHttpHandler>[0]) {}

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Device listener is shutting down.'))
    this.starting ??= this.open()
    return this.starting
  }
  private async open(): Promise<void> {
    const materials = await Promise.allSettled([
      readFile(this.config.certificateFile), readFile(this.config.privateKeyFile),
      ...(this.config.trustCertificateFile ? [readFile(this.config.trustCertificateFile)] : []),
    ])
    if (materials.some((item) => item.status === 'rejected')) throw new Error('The approved device TLS materials are unavailable.')
    if (this.closing) throw new Error('Device listener startup was canceled.')
    const certificate = materials[0] as PromiseFulfilledResult<Buffer>
    const key = materials[1] as PromiseFulfilledResult<Buffer>
    const x509 = new X509Certificate(certificate.value)
    if (this.config.advertisedEndpoint) {
      const hostname = new URL(this.config.advertisedEndpoint).hostname.replace(/^\[|\]$/g, '')
      if (!(isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname))) throw new Error('The approved device TLS certificate does not match its public endpoint.')
    }
    let publicTrust: import('@foreman-code/contracts/device-identity').DeviceTlsTrust | undefined
    const anchor = materials[2]
    if (anchor?.status === 'fulfilled') {
      const certificatePem = anchor.value.toString('utf8')
      if (Buffer.byteLength(certificatePem) > 8192 || /PRIVATE KEY/.test(certificatePem)
        || (certificatePem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) throw new Error('The approved public device trust anchor is invalid.')
      const ca = new X509Certificate(certificatePem)
      if (!ca.ca || !x509.verify(ca.publicKey)) throw new Error('The approved device TLS leaf is not signed by its app-specific CA.')
      publicTrust = { certificatePem, sha256: createHash('sha256').update(ca.raw).digest('hex') }
    }
    const server = createServer({ cert: certificate.value, key: key.value, minVersion: 'TLSv1.2',
      handshakeTimeout: 10_000, maxHeaderSize: DEVICE_FRAME_BYTES }, deviceHttpHandler(this.http))
    this.server = server
    server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 64; server.maxConnections = 128
    server.on('connection', (socket) => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
    const websocket = new WebSocketServer({ noServer: true, maxPayload: DEVICE_FRAME_BYTES, perMessageDeflate: false })
    this.websocket = websocket
    server.on('upgrade', deviceUpgradeHandler(this.endpoint, websocket))
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error) }
      const ready = () => { server.off('error', failed); resolve() }
      server.once('error', failed); server.once('listening', ready)
      server.listen({ host: this.config.host, port: this.config.port })
    })
    if (this.closing) throw new Error('Device listener startup was canceled.')
    this.publicTrust = publicTrust
  }
  close(): Promise<void> {
    this.closing = true
    this.endpoint.close()
    if (this.stopping) return this.stopping
    const attempt = this.finish()
    this.stopping = attempt
    void attempt.catch(() => { if (this.stopping === attempt) this.stopping = undefined })
    return attempt
  }
  private async finish(): Promise<void> {
    await this.starting?.catch(() => undefined)
    const server = this.server
    const websocket = this.websocket
    if (!server) return
    const timer = setTimeout(() => {
      for (const client of websocket?.clients ?? []) client.terminate()
      for (const socket of this.sockets) socket.destroy()
    }, 5_000)
    timer.unref()
    try {
      for (const client of websocket?.clients ?? []) client.close()
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          if (this.serverClosed) { resolve(); return }
          server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else { this.serverClosed = true; resolve() }
        })
        }),
        new Promise<void>((resolve, reject) => {
          if (!websocket || this.websocketClosed) { resolve(); return }
          websocket.close((error) => { if (error) reject(error); else { this.websocketClosed = true; resolve() } })
        }),
      ])
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Device listener closure was incomplete.')
    } finally { clearTimeout(timer) }
  }
}
