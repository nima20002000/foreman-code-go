import { randomUUID } from 'node:crypto'
import { DEVICE_PROTOCOL_VERSION, type DeviceConnectionView, type DeviceHello, type DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { DeviceConnectionError, nextFrame, readFrame, sendFrame, withDeviceDeadline, type DeviceSocket } from './deviceWire.js'

const blocked = new Set(['authentication', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame'])
export class DeviceConnectionSupervisor {
  private state: DeviceConnectionView = { desired: false, phase: 'disconnected', generation: 0, failure: null }
  private task: Promise<void> | undefined
  private abort: AbortController | undefined
  private socket: DeviceSocket | undefined
  constructor(private readonly options: {
    identity: Omit<DeviceSessionBinding, 'connectionEpoch'>; appVersion: string
    connect(signal: AbortSignal): Promise<DeviceSocket>
    reconcile(binding: DeviceSessionBinding, signal: AbortSignal): Promise<void>
    onState?(view: DeviceConnectionView): void
    handshakeMs?: number; heartbeatMs?: number; random?: () => number
  }) {}
  status(): DeviceConnectionView { return { ...this.state } }
  private update(phase: DeviceConnectionView['phase'], failure: DeviceConnectionView['failure'] = null) {
    this.state = { ...this.state, phase, failure }; this.options.onState?.(this.status())
  }
  start(): void {
    if (this.task) return
    this.abort = new AbortController(); this.state.desired = true
    this.task = this.run(this.abort.signal).finally(() => { this.task = undefined })
  }
  async stop(): Promise<void> {
    this.state.desired = false; this.abort?.abort(); this.socket?.close(); await this.task
    this.update('disconnected')
  }
  private async run(signal: AbortSignal) {
    let failures = 0
    while (!signal.aborted) {
      this.state.generation++
      const attempt = new AbortController()
      const cancel = () => attempt.abort()
      signal.addEventListener('abort', cancel, { once: true })
      let socket: DeviceSocket | undefined
      try {
        this.update('connecting')
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          socket = await Promise.race([
            this.options.connect(attempt.signal).then((value) => { if (attempt.signal.aborted) { value.close(); throw new DeviceConnectionError('transport') }; return value }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { attempt.abort(); reject(new DeviceConnectionError('timeout')) }, this.options.handshakeMs ?? 10_000); attempt.signal.addEventListener('abort', () => reject(new DeviceConnectionError('transport')), { once: true }) }),
          ])
        } finally { if (timer) clearTimeout(timer) }
        this.socket = socket
        this.update('authenticating')
        const hello: DeviceHello = { ...this.options.identity, connectionEpoch: randomUUID(), type: 'hello', protocolVersion: DEVICE_PROTOCOL_VERSION, appVersion: this.options.appVersion }
        sendFrame(socket, hello); this.update('negotiating')
        const iterator = socket.messages[Symbol.asyncIterator]()
        const next = await nextFrame(iterator, attempt.signal, this.options.handshakeMs ?? 10_000)
        if (next.done) throw new DeviceConnectionError('transport')
        const frame = readFrame(next.value)
        if (frame.type === 'blocked') throw new DeviceConnectionError(classifiedFailure(frame.code))
        if (frame.protocolVersion !== DEVICE_PROTOCOL_VERSION) throw new DeviceConnectionError('incompatible-protocol')
        if (frame.mainId !== hello.mainId) throw new DeviceConnectionError('wrong-main')
        for (const key of ['deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'] as const) if (frame[key] !== hello[key]) throw new DeviceConnectionError('authentication')
        const capabilities = frame.capabilities as Record<string, unknown> | undefined
        if (frame.type !== 'welcome' || typeof frame.connectionEpoch !== 'string' || !frame.connectionEpoch || !capabilities || capabilities.heartbeat !== true || capabilities.dispatch !== false || capabilities.transfer !== false) throw new DeviceConnectionError('malformed-frame')
        const binding = { ...this.options.identity, connectionEpoch: frame.connectionEpoch }
        this.update('synchronizing'); await withDeviceDeadline(this.options.reconcile(binding, attempt.signal), attempt.signal, this.options.handshakeMs ?? 10_000)
        if (attempt.signal.aborted) break
        this.update('ready'); failures = 0
        while (!attempt.signal.aborted) {
          sendFrame(socket, { type: 'ping', connectionEpoch: binding.connectionEpoch })
          const pong = await nextFrame(iterator, attempt.signal, this.options.heartbeatMs ?? 15_000)
          if (pong.done) throw new DeviceConnectionError('transport')
          const received = readFrame(pong.value)
          if (received.type === 'blocked') throw new DeviceConnectionError(classifiedFailure(received.code))
          if (received.type !== 'pong' || received.connectionEpoch !== binding.connectionEpoch) throw new DeviceConnectionError('malformed-frame')
          await pause(this.options.heartbeatMs ?? 15_000, attempt.signal)
        }
      } catch (error) {
        if (signal.aborted) break
        const code = error instanceof DeviceConnectionError ? error.code : 'transport'
        if (blocked.has(code)) { this.update('blocked', code); return }
        attempt.abort(); socket?.close(); this.socket = undefined
        this.update('backoff', code)
        const delay = Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)) * (0.75 + (this.options.random?.() ?? Math.random()) * 0.5)
        await pause(delay, signal)
      } finally { attempt.abort(); signal.removeEventListener('abort', cancel); socket?.close(); this.socket = undefined }
    }
  }
}
function classifiedFailure(code: unknown): import('@graphql/contracts/device-connection').DeviceFailureCode {
  return ['authentication', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame', 'backpressure', 'timeout', 'transport'].includes(String(code)) ? code as import('@graphql/contracts/device-connection').DeviceFailureCode : 'malformed-frame'
}
function pause(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true })
  })
}
