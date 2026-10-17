import { createHash, randomBytes, randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import {
  DEVICE_BUFFER_BYTES, DEVICE_FRAME_BYTES, DEVICE_PROTOCOL_VERSION, DeviceSessionBindingSchema,
  type DeviceFrame, type DeviceHello, type DeviceSessionBinding, type DeviceWelcome,
} from '@foreman-code/contracts/device-connection'
import { MainIdentityProofRequestSchema, WorkerPairingConfigurationSchema,
  type WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { verifyMainIdentityProof } from '@foreman-code/contracts/device-identity-node'
import { deviceTlsOptions } from '@foreman-code/contracts/device-tls-node'
import { parseExtensionDescriptors, type DeviceApplicationFrame,
  type DeviceNegotiatedExtension } from '@foreman-code/contracts/device-application'
import { deferred, withWorkerDeadline } from './workerDeferred.js'
import { TestWorkerChannel } from './workerChannel.js'
import type { TestWorkerExtension, TestWorkerOperation } from './workerExtensions.js'

export interface ConnectTestWorkerOptions {
  pairing: WorkerPairingConfiguration
  appVersion?: string
  extensions?: TestWorkerExtension[]
  signal?: AbortSignal
}

function parseFrame(data: RawData, binary: boolean): DeviceFrame {
  if (binary || Buffer.byteLength(String(data)) > DEVICE_FRAME_BYTES) throw new Error('Invalid worker WebSocket frame size or encoding.')
  const frame: unknown = JSON.parse(String(data))
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !('type' in frame)
    || typeof frame.type !== 'string') throw new Error('The worker received a malformed protocol frame.')
  return frame as DeviceFrame
}

function negotiatedExtensions(welcome: DeviceWelcome, registrations: TestWorkerExtension[]) {
  const proposed = parseExtensionDescriptors(registrations)
  const accepted: DeviceNegotiatedExtension[] = welcome.capabilities.extensions ?? []
  if (!Array.isArray(accepted) || accepted.length > proposed.length) throw new Error('The main returned an invalid extension negotiation.')
  const seen = new Set<string>()
  for (const extension of accepted) {
    const proposal = proposed.find(entry => entry.namespace === extension.namespace)
    if (!proposal || seen.has(extension.namespace) || extension.version !== proposal.version
      || typeof extension.mainCanRequest !== 'boolean' || typeof extension.workerCanRequest !== 'boolean'
      || extension.mainCanRequest && proposal.role === 'client'
      || extension.workerCanRequest && proposal.role === 'server'
      || !Number.isSafeInteger(extension.maxJsonBytes) || extension.maxJsonBytes < 256 || extension.maxJsonBytes > proposal.maxJsonBytes
      || !Number.isSafeInteger(extension.maxBinaryBytes) || extension.maxBinaryBytes < 0 || extension.maxBinaryBytes > proposal.maxBinaryBytes
      || extension.observationAdmission && !proposal.observationAdmission
      || extension.ciStopAdmission && !proposal.ciStopAdmission) throw new Error('The main changed an offered worker extension.')
    seen.add(extension.namespace)
  }
  return accepted
}

export class TestWorkerClient {
  private readonly socket: WebSocket
  private readonly lifetime = new AbortController()
  private readonly readyState = deferred<void>()
  private readonly closedState = deferred<void>()
  private readonly welcomeState = deferred<DeviceWelcome>()
  private readonly observed: TestWorkerOperation[] = []
  private readonly waiters = new Set<{
    predicate(operation: TestWorkerOperation): boolean
    result: ReturnType<typeof deferred<TestWorkerOperation>>
  }>()
  private channel: TestWorkerChannel | undefined
  private channelClosing: Promise<void> | undefined
  private closeRequested = false
  private binding: Readonly<DeviceSessionBinding> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private failure: Error | undefined

  constructor(private readonly options: ConnectTestWorkerOptions) {
    const pairing = WorkerPairingConfigurationSchema.parse(options.pairing)
    const url = new URL(pairing.endpoint)
    if (url.protocol !== 'wss:' || url.pathname !== '/device/connect'
      || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
      throw new Error('A test worker requires the isolated TLS device endpoint.')
    }
    for (const extension of options.extensions ?? []) {
      if (extension.role !== 'client' && !extension.handle) throw new Error('Every offered worker server extension needs a real script handler.')
    }
    this.socket = new WebSocket(url, { ...deviceTlsOptions(pairing.tlsTrust),
      headers: { Authorization: `Bearer ${pairing.credential}` }, perMessageDeflate: false,
      maxPayload: DEVICE_FRAME_BYTES, handshakeTimeout: 10_000 })
    this.socket.on('message', (data, binary) => {
      try { this.receive(parseFrame(data, binary)) }
      catch (error) { this.fail(error instanceof Error ? error : new Error('Worker protocol decoding failed.')) }
    })
    this.socket.on('error', error => this.fail(error))
    this.socket.on('close', () => {
      this.closedState.resolve()
      if (!this.closeRequested) this.fail(this.failure ?? new Error('The worker socket closed.'))
    })
    this.socket.on('unexpected-response', (_request, response) => {
      response.resume()
      this.fail(new Error(`Worker WebSocket authentication returned HTTP ${response.statusCode ?? 0}.`))
    })
    options.signal?.addEventListener('abort', () => this.fail(new Error('The worker scenario was canceled.')), { once: true })
    if (options.signal?.aborted) this.fail(new Error('The worker scenario was canceled.'))
  }

  private send(frame: DeviceFrame) {
    this.lifetime.signal.throwIfAborted()
    const text = JSON.stringify(frame)
    const size = Buffer.byteLength(text)
    if (size > DEVICE_FRAME_BYTES || this.socket.bufferedAmount + size > DEVICE_BUFFER_BYTES) {
      throw new Error('The test worker exceeded the device carrier bound.')
    }
    this.socket.send(text)
  }

  private receive(frame: DeviceFrame) {
    if (frame.type === 'blocked') { this.fail(new Error(`The main blocked the worker: ${frame.code}.`)); return }
    if (frame.type === 'welcome') { this.welcomeState.resolve(frame); return }
    if (!this.binding) throw new Error('The main sent application traffic before worker identity negotiation.')
    if (frame.type === 'ping' || frame.type === 'pong') {
      if (frame.connectionEpoch !== this.binding.connectionEpoch) throw new Error('The heartbeat belongs to another worker connection.')
      if (frame.type === 'ping') this.send({ type: 'pong', connectionEpoch: this.binding.connectionEpoch, observedAt: new Date().toISOString() })
      if (frame.type === 'pong' && frame.mainReady === true) this.readyState.resolve()
      return
    }
    if (!frame.type.startsWith('application-')) throw new Error('The main sent an unexpected worker frame.')
    this.channel?.receive(frame as DeviceApplicationFrame)
  }

  async start() {
    const opened = deferred<void>()
    this.socket.once('open', () => opened.resolve())
    if (this.socket.readyState === WebSocket.OPEN) opened.resolve()
    await withWorkerDeadline(opened.promise, this.lifetime.signal)
    const pairing = this.options.pairing
    const hello: DeviceHello = { type: 'hello', protocolVersion: DEVICE_PROTOCOL_VERSION,
      appVersion: this.options.appVersion ?? 'conformance-fixture',
      mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
      keyRevision: pairing.keyRevision, authorizationRevision: pairing.authorizationRevision,
      bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID(),
      nonce: randomBytes(32).toString('base64url'), observedAt: new Date().toISOString(),
      extensions: parseExtensionDescriptors(this.options.extensions ?? []) }
    this.send(hello)
    const welcome = await withWorkerDeadline(this.welcomeState.promise, this.lifetime.signal)
    const binding = DeviceSessionBindingSchema.strip().parse(welcome)
    if (welcome.protocolVersion !== DEVICE_PROTOCOL_VERSION || welcome.capabilities?.heartbeat !== true
      || typeof welcome.appVersion !== 'string' || !welcome.appVersion) throw new Error('Invalid worker welcome response.')
    for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision',
      'bootId', 'connectionGeneration'] as const) {
      if (binding[key] !== hello[key]) throw new Error('The main welcomed a different worker identity.')
    }
    const extensions = negotiatedExtensions(welcome, this.options.extensions ?? [])
    const expected = MainIdentityProofRequestSchema.parse({ audience: 'graphql-worker-main-v1', ...binding,
      nonce: hello.nonce, connectionEpoch: hello.connectionEpoch, mainConnectionEpoch: binding.connectionEpoch,
      protocolVersion: DEVICE_PROTOCOL_VERSION, workerApplicationVersion: hello.appVersion,
      negotiationHash: createHash('sha256').update(JSON.stringify(extensions)).digest('hex') })
    if (!await verifyMainIdentityProof(welcome.mainIdentityProof, expected, pairing.mainPublicKeyFingerprint)) {
      throw new Error('The worker connection did not prove the approved main identity and negotiated extensions.')
    }
    this.binding = Object.freeze(binding)
    this.channel = new TestWorkerChannel({ binding: this.binding, extensions,
      registrations: this.options.extensions ?? [], send: frame => this.send(frame),
      fail: error => this.fail(error), observe: operation => this.observe(operation) })
    this.send({ type: 'ready', connectionEpoch: binding.connectionEpoch, observedAt: new Date().toISOString() })
    await this.ready()
    this.heartbeat = setInterval(() => {
      try { this.send({ type: 'ping', connectionEpoch: binding.connectionEpoch, observedAt: new Date().toISOString() }) }
      catch (error) { this.fail(error instanceof Error ? error : new Error('Worker heartbeat failed.')) }
    }, 5_000)
    this.heartbeat.unref()
    return this
  }

  ready() { return withWorkerDeadline(this.readyState.promise, this.lifetime.signal) }

  currentBinding() {
    this.lifetime.signal.throwIfAborted()
    if (!this.binding) throw new Error('The test worker is not connected.')
    return this.binding
  }

  request(namespace: string, payload: unknown, options?: { bytes?: Uint8Array; signal?: AbortSignal }) {
    if (!this.channel) throw new Error('The test worker has no negotiated application channel.')
    return this.channel.request(namespace, payload, options)
  }

  private observe(operation: TestWorkerOperation) {
    this.observed.push(operation)
    for (const waiter of this.waiters) {
      if (waiter.predicate(operation)) { this.waiters.delete(waiter); waiter.result.resolve(operation) }
    }
  }

  async waitForOperation(predicate: (operation: TestWorkerOperation) => boolean, signal?: AbortSignal) {
    const recorded = this.observed.find(predicate)
    if (recorded) return recorded
    const result = deferred<TestWorkerOperation>()
    const waiter = { predicate, result }
    this.waiters.add(waiter)
    try { return await withWorkerDeadline(result.promise, signal ?? this.lifetime.signal) }
    finally { this.waiters.delete(waiter) }
  }

  private fail(error: Error) {
    this.failure ??= error
    this.stop(error)
  }

  private stop(error: Error) {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(error)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.readyState.reject(error)
    this.welcomeState.reject(error)
    for (const waiter of this.waiters) waiter.result.reject(error)
    if (this.channel && !this.channelClosing) {
      this.channelClosing = this.channel.close(error)
      // close() awaits and reports this rejection even if protocol failure
      // stopped the socket before the scenario reached its cleanup block.
      void this.channelClosing.catch(() => {})
    }
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
  }

  async close() {
    this.closeRequested = true
    this.stop(this.failure ?? new Error('The test worker closed.'))
    const failures: unknown[] = []
    try { await this.channelClosing } catch (error) { failures.push(error) }
    try {
      if (this.socket.readyState !== WebSocket.CLOSED) await withWorkerDeadline(this.closedState.promise)
    } catch (error) { failures.push(error) }
    if (this.failure) failures.unshift(this.failure)
    const unique = [...new Set(failures)]
    if (unique.length === 1) throw unique[0]
    if (unique.length > 1) throw new AggregateError(unique, 'Worker protocol and owned cleanup failed.')
  }
}

export async function connectTestWorker(options: ConnectTestWorkerOptions) {
  const client = new TestWorkerClient(options)
  try { return await client.start() }
  catch (error) {
    try { await client.close() }
    catch (cleanup) {
      if (cleanup !== error) throw new AggregateError([error, cleanup], 'Worker startup and cleanup failed.')
    }
    throw error
  }
}
