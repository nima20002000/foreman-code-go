import { randomUUID } from 'node:crypto'
import { DEVICE_PROTOCOL_VERSION, type DeviceSessionBinding, type DeviceWelcome } from '@graphql/contracts/device-connection'
import { DeviceConnectionError, nextFrame, readFrame, sendFrame, withDeviceDeadline, type DeviceSocket } from './deviceWire.js'

export interface AuthenticatedDevice {
  audience: 'graphql-worker'
  mainId: string
  deviceId: string
  workerInstallationId: string
  keyRevision: number
  authorizationRevision: number
  expiresAt: string
}
export interface DeviceAuthenticator {
  authenticateDevice(token: string, scope: 'connect'): Promise<AuthenticatedDevice>
  revalidateDevice(principal: AuthenticatedDevice, scope: 'heartbeat'): Promise<void>
}
export interface DevicePresence {
  binding: DeviceSessionBinding
  phase: 'ready' | 'offline'
  dispatch: false
  transfer: false
}
const permanentAuth = (error: unknown) => {
  const code = (error as { code?: string })?.code
  if (code === 'wrong_main') return new DeviceConnectionError('wrong-main')
  if (code === 'forbidden') return new DeviceConnectionError('permission')
  return new DeviceConnectionError('authentication')
}
/** Mount on a separately approved device-only listener, never the browser/MCP server. */
export class DeviceEndpoint {
  private readonly sessions = new Map<string, { epoch: string; socket: DeviceSocket; abort: AbortController }>()
  private closed = false
  private readonly pending = new Set<AbortController>()
  constructor(private readonly options: {
    mainId: string; appVersion: string; auth: DeviceAuthenticator
    reconcile(binding: DeviceSessionBinding, signal: AbortSignal): Promise<void>
    presence(view: DevicePresence): void
    handshakeMs?: number; heartbeatMs?: number
  }) {}

  async authenticate(headers: { authorization?: string; cookie?: string; origin?: string }): Promise<AuthenticatedDevice> {
    if (this.pending.size >= 32) throw new DeviceConnectionError('backpressure')
    const abort = new AbortController(); this.pending.add(abort)
    try {
      if (this.closed || headers.cookie !== undefined || headers.origin !== undefined || !headers.authorization?.startsWith('Bearer ')) throw new DeviceConnectionError('authentication')
      let principal: AuthenticatedDevice
      try { principal = await withDeviceDeadline(this.options.auth.authenticateDevice(headers.authorization.slice(7), 'connect'), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { if (error instanceof DeviceConnectionError) throw error; throw permanentAuth(error) }
      if (this.closed || abort.signal.aborted) throw new DeviceConnectionError('transport')
      if (principal.audience !== 'graphql-worker' || principal.mainId !== this.options.mainId) throw new DeviceConnectionError('wrong-main')
      return principal
    } finally { abort.abort(); this.pending.delete(abort) }
  }
  async accept(headers: { authorization?: string; cookie?: string; origin?: string }, socket: DeviceSocket): Promise<void> {
    try {
      const principal = await this.authenticate(headers)
      await this.acceptAuthenticated(principal, socket)
    } catch (error) {
      try { sendFrame(socket, { type: 'blocked', code: error instanceof DeviceConnectionError ? error.code : 'transport' }) } catch { /* socket unavailable */ }
      socket.close()
    }
  }
  async acceptAuthenticated(authenticated: AuthenticatedDevice, socket: DeviceSocket): Promise<void> {
    const abort = new AbortController()
    const principal = authenticated
    let binding: DeviceSessionBinding | undefined
    try {
      if (this.closed || principal.mainId !== this.options.mainId || principal.audience !== 'graphql-worker') throw new DeviceConnectionError('authentication')
      const previous = this.sessions.get(principal.deviceId)
      previous?.abort.abort(); previous?.socket.close()
      const epoch = randomUUID()
      this.sessions.set(principal.deviceId, { epoch, socket, abort })
      const current = () => !abort.signal.aborted && this.sessions.get(principal!.deviceId)?.epoch === epoch
      const iterator = socket.messages[Symbol.asyncIterator]()
      const first = await nextFrame(iterator, abort.signal, this.options.handshakeMs ?? 10_000)
      if (first.done || !current()) throw new DeviceConnectionError('transport')
      const hello = readFrame(first.value)
      if (hello.protocolVersion !== DEVICE_PROTOCOL_VERSION) throw new DeviceConnectionError('incompatible-protocol')
      if (hello.type !== 'hello' || typeof hello.bootId !== 'string' || !hello.bootId || typeof hello.connectionEpoch !== 'string' || !hello.connectionEpoch || typeof hello.appVersion !== 'string') throw new DeviceConnectionError('malformed-frame')
      for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) if (hello[key] !== principal[key]) throw new DeviceConnectionError('authentication')
      binding = { mainId: principal.mainId, deviceId: principal.deviceId, workerInstallationId: principal.workerInstallationId, keyRevision: principal.keyRevision, authorizationRevision: principal.authorizationRevision, bootId: hello.bootId, connectionEpoch: epoch }
      await withDeviceDeadline(this.options.reconcile(binding, abort.signal), abort.signal, this.options.handshakeMs ?? 10_000)
      if (!current()) throw new DeviceConnectionError('transport')
      try { await withDeviceDeadline(this.options.auth.revalidateDevice(principal, 'heartbeat'), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { if (error instanceof DeviceConnectionError) throw error; throw permanentAuth(error) }
      if (!current()) throw new DeviceConnectionError('transport')
      const welcome: DeviceWelcome = { ...binding, type: 'welcome', protocolVersion: DEVICE_PROTOCOL_VERSION, appVersion: this.options.appVersion, capabilities: { heartbeat: true, dispatch: false, transfer: false } }
      sendFrame(socket, welcome)
      this.options.presence({ binding, phase: 'ready', dispatch: false, transfer: false })
      while (current()) {
        const next = await nextFrame(iterator, abort.signal, this.options.heartbeatMs ?? 30_000)
        if (next.done || !current()) break
        const frame = readFrame(next.value)
        if (frame.type !== 'ping' || frame.connectionEpoch !== epoch) throw new DeviceConnectionError('malformed-frame')
        try { await withDeviceDeadline(this.options.auth.revalidateDevice(principal, 'heartbeat'), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { if (error instanceof DeviceConnectionError) throw error; throw permanentAuth(error) }
        if (!current()) break
        sendFrame(socket, { type: 'pong', connectionEpoch: epoch })
      }
    } catch (error) {
      try { sendFrame(socket, { type: 'blocked', code: error instanceof DeviceConnectionError ? error.code : 'transport' }) } catch { /* socket already unavailable */ }
    } finally {
      abort.abort(); socket.close()
      if (principal && this.sessions.get(principal.deviceId)?.abort === abort) {
        this.sessions.delete(principal.deviceId)
        if (binding) this.options.presence({ binding, phase: 'offline', dispatch: false, transfer: false })
      }
    }
  }
  revoke(deviceId: string) { const session = this.sessions.get(deviceId); session?.abort.abort(); session?.socket.close() }
  close() { this.closed = true; for (const abort of this.pending) abort.abort(); for (const session of this.sessions.values()) { session.abort.abort(); session.socket.close() } }
}
