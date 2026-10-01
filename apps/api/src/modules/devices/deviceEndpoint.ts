import { negotiateDeviceExtensions, parseExtensionDescriptors } from '@graphql/contracts/device-application'
import { DeviceApplicationChannel, deviceNegotiationHash, extensionDescriptors, type DeviceApplicationRequestOptions, type DeviceExtensionRegistration } from './deviceApplicationChannel.js'
import type { DevicePrincipal, MainIdentityProofRequest, MainSignedIdentityProof } from '@graphql/contracts/device-identity'
import { randomUUID } from 'node:crypto'
import { DEVICE_PROTOCOL_VERSION, type DeviceSessionBinding, type DeviceWelcome } from '@graphql/contracts/device-connection'
import { DeviceConnectionError, nextFrame, readFrame, sendFrame, withDeviceDeadline, type DeviceSocket } from './deviceWire.js'

export type AuthenticatedDevice = DevicePrincipal

export interface DeviceAuthenticator {
  authenticateDevice(token: string, scope: 'connect'): Promise<AuthenticatedDevice>
  revalidateDevice(principal: AuthenticatedDevice, scope: 'heartbeat'): Promise<void>
}
export interface DevicePresence {
  binding: DeviceSessionBinding
  phase: 'ready' | 'offline'
  dispatch: boolean
  transfer: boolean
}
const authorizationFailure = (error: unknown) => {
  const code = (error as { code?: string })?.code
  if (code === 'wrong_main') return new DeviceConnectionError('wrong-main')
  if (code === 'forbidden') return new DeviceConnectionError('permission')
  if (code === 'unauthorized' || code === 'revoked' || code === 'expired') return new DeviceConnectionError('authentication')
  return error instanceof DeviceConnectionError ? error : new DeviceConnectionError('transport')
}
/** Mount on a separately approved device-only listener, never the browser/MCP server. */
export class DeviceEndpoint {
  private readonly sessions = new Map<string, { epoch: string; authorizationRevision: number; socket: DeviceSocket; abort: AbortController; binding?: DeviceSessionBinding }>()
  private closed = false
  private readonly channels = new Map<string, DeviceApplicationChannel>()
  private readonly revoked = new Map<string, number>()
  private readonly tickets = new WeakSet<AuthenticatedDevice>()
  private readonly pending = new Set<AbortController>()
  constructor(private readonly options: {
    mainId: string; appVersion: string; auth: DeviceAuthenticator
    signMainIdentityProof(request: MainIdentityProofRequest): Promise<MainSignedIdentityProof>
    reconcile(binding: DeviceSessionBinding, signal: AbortSignal): Promise<void>
    presence(view: DevicePresence): void
    handshakeMs?: number; heartbeatMs?: number; extensions?: DeviceExtensionRegistration[]
  }) { extensionDescriptors(options.extensions ?? []) }

  async authenticate(headers: { authorization?: string; cookie?: string; origin?: string }): Promise<AuthenticatedDevice> {
    if (this.pending.size >= 32) throw new DeviceConnectionError('backpressure')
    const abort = new AbortController(); this.pending.add(abort)
    try {
      if (this.closed || headers.cookie !== undefined || headers.origin !== undefined || !headers.authorization?.startsWith('Bearer ')) throw new DeviceConnectionError('authentication')
      let principal: AuthenticatedDevice
      try { principal = await withDeviceDeadline(this.options.auth.authenticateDevice(headers.authorization.slice(7), 'connect'), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { throw authorizationFailure(error) }
      if (this.closed || abort.signal.aborted) throw new DeviceConnectionError('transport')
      if (principal.audience !== 'graphql-worker' || principal.mainId !== this.options.mainId) throw new DeviceConnectionError('wrong-main')
      if (principal.authorizationRevision <= (this.revoked.get(principal.deviceId) ?? 0)) throw new DeviceConnectionError('authentication')
      this.tickets.add(principal)
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
      if (!this.tickets.has(principal) || principal.authorizationRevision <= (this.revoked.get(principal.deviceId) ?? 0)) throw new DeviceConnectionError('authentication')
      const previous = this.sessions.get(principal.deviceId)
      previous?.abort.abort(); previous?.socket.close()
      if (previous?.binding) this.options.presence({ binding: previous.binding, phase: 'offline', dispatch: false, transfer: false })
      const epoch = randomUUID()
      this.sessions.set(principal.deviceId, { epoch, authorizationRevision: principal.authorizationRevision, socket, abort })
      const current = () => !abort.signal.aborted && this.sessions.get(principal!.deviceId)?.epoch === epoch
      const iterator = socket.messages[Symbol.asyncIterator]()
      const first = await nextFrame(iterator, abort.signal, this.options.handshakeMs ?? 10_000)
      if (first.done || !current()) throw new DeviceConnectionError('transport')
      const hello = readFrame(first.value)
      if (hello.protocolVersion !== DEVICE_PROTOCOL_VERSION) throw new DeviceConnectionError('incompatible-protocol')
      if (hello.type !== 'hello' || typeof hello.bootId !== 'string' || !hello.bootId || typeof hello.connectionEpoch !== 'string' || !hello.connectionEpoch || typeof hello.appVersion !== 'string' || typeof hello.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(hello.nonce) || !Number.isSafeInteger(hello.connectionGeneration) || Number(hello.connectionGeneration) < 1) throw new DeviceConnectionError('malformed-frame')
      for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) if (hello[key] !== principal[key]) throw new DeviceConnectionError('authentication')
      binding = { mainId: principal.mainId, deviceId: principal.deviceId, workerInstallationId: principal.workerInstallationId, keyRevision: principal.keyRevision, authorizationRevision: principal.authorizationRevision, bootId: hello.bootId, connectionEpoch: epoch, connectionGeneration: Number(hello.connectionGeneration) }
      const session = this.sessions.get(principal.deviceId)
      if (session?.abort === abort) session.binding = binding
      try { await withDeviceDeadline(this.options.auth.revalidateDevice(principal, 'heartbeat'), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { throw authorizationFailure(error) }
      if (!current()) throw new DeviceConnectionError('transport')
      let extensions
      try { extensions = negotiateDeviceExtensions(extensionDescriptors(this.options.extensions ?? []), parseExtensionDescriptors(hello.extensions ?? [])) } catch { throw new DeviceConnectionError('malformed-frame') }
      const proofRequest: MainIdentityProofRequest = { audience: 'graphql-worker-main-v1', ...binding, nonce: hello.nonce as string, connectionGeneration: Number(hello.connectionGeneration), connectionEpoch: hello.connectionEpoch as string, mainConnectionEpoch: epoch, protocolVersion: DEVICE_PROTOCOL_VERSION, workerApplicationVersion: hello.appVersion as string, negotiationHash: deviceNegotiationHash(extensions) }
      const mainIdentityProof = await withDeviceDeadline(this.options.signMainIdentityProof(proofRequest), abort.signal, this.options.handshakeMs ?? 10_000)
      if (!current()) throw new DeviceConnectionError('transport')
      const welcome: DeviceWelcome = { ...binding, type: 'welcome', protocolVersion: DEVICE_PROTOCOL_VERSION, appVersion: this.options.appVersion, mainIdentityProof, capabilities: { heartbeat: true, dispatch: extensions.some((item) => ['execution-v1', 'job-v1'].includes(item.namespace) && item.mainCanRequest), transfer: extensions.some((item) => item.namespace === 'byte-transfer-v1' && (item.mainCanRequest || item.workerCanRequest)), extensions } }
      sendFrame(socket, welcome)
      const acknowledged = await nextFrame(iterator, abort.signal, this.options.handshakeMs ?? 10_000)
      if (acknowledged.done || !current()) throw new DeviceConnectionError('transport')
      const ready = readFrame(acknowledged.value)
      if (ready.type !== 'ready' || ready.connectionEpoch !== epoch) throw new DeviceConnectionError('malformed-frame')
      try { await withDeviceDeadline(this.options.auth.revalidateDevice(principal, 'heartbeat'), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { throw authorizationFailure(error) }
      if (!current()) throw new DeviceConnectionError('transport')
      const channel = new DeviceApplicationChannel({ side: 'main', binding, socket, signal: abort.signal, extensions, registrations: this.options.extensions ?? [], revalidate: async () => { try { await this.options.auth.revalidateDevice(principal, 'heartbeat') } catch (error) { throw authorizationFailure(error) } } })
      this.channels.set(principal.deviceId, channel)
      const channelTask = channel.run(iterator, this.options.heartbeatMs ?? 30_000).catch((error: unknown) => { abort.abort(); throw error })
      void channelTask.catch(() => undefined)
      await withDeviceDeadline(this.options.reconcile(binding, abort.signal), abort.signal, this.options.handshakeMs ?? 10_000)
      if (!current()) throw new DeviceConnectionError('transport')
      this.options.presence({ binding, phase: 'ready', dispatch: welcome.capabilities.dispatch, transfer: welcome.capabilities.transfer })
      await channelTask
    } catch (error) {
      try { sendFrame(socket, { type: 'blocked', code: error instanceof DeviceConnectionError ? error.code : 'transport' }) } catch { /* socket already unavailable */ }
    } finally {
      abort.abort(); socket.close()
      if (principal && this.sessions.get(principal.deviceId)?.abort === abort) {
        this.channels.get(principal.deviceId)?.close(); this.channels.delete(principal.deviceId)
        this.sessions.delete(principal.deviceId)
        if (binding) this.options.presence({ binding, phase: 'offline', dispatch: false, transfer: false })
      }
    }
  }
  async request(deviceId: string, namespace: string, payload: unknown, options?: DeviceApplicationRequestOptions) {
    const channel = this.channels.get(deviceId)
    if (!channel) throw new DeviceConnectionError('transport')
    return channel.request(namespace, payload, options)
  }
  capabilities(deviceId: string) { return this.channels.get(deviceId)?.capabilities() ?? [] }
  /** A committed revoke receipt fences its revision, including lost-response replay. */
  revoke(deviceId: string, authorizationRevision: number) {
    const revision = Math.max(this.revoked.get(deviceId) ?? 0, authorizationRevision)
    this.revoked.set(deviceId, revision)
    const session = this.sessions.get(deviceId)
    if (session && session.authorizationRevision <= revision) { this.channels.get(deviceId)?.close(new DeviceConnectionError('authentication')); session.abort.abort(); session.socket.close() }
  }
  close() { this.closed = true; for (const abort of this.pending) abort.abort(); for (const session of this.sessions.values()) { session.abort.abort(); session.socket.close() } }
}
