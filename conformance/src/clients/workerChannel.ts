import { randomUUID } from 'node:crypto'
import {
  DEVICE_APPLICATION_BUFFER_BYTES, DEVICE_APPLICATION_CHUNK_BYTES, DEVICE_APPLICATION_IN_FLIGHT,
  type DeviceApplicationFrame, type DeviceApplicationResult,
  type DeviceNegotiatedExtension,
} from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { deferred, withWorkerDeadline } from './workerDeferred.js'
import { TestWorkerOperationError, type TestWorkerExtension, type TestWorkerOperation } from './workerExtensions.js'

type OpenFrame = Extract<DeviceApplicationFrame, { type: 'application-open' }>
interface Assembly { frame: OpenFrame; chunks: Buffer[]; received: number; lifetime: AbortController }

export class TestWorkerChannel {
  private readonly pending = new Map<string, ReturnType<typeof deferred<DeviceApplicationResult>>>()
  private readonly acknowledgements = new Map<string, ReturnType<typeof deferred<void>>>()
  private readonly assemblies = new Map<string, Assembly>()
  private readonly operations = new Map<string, AbortController>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private reservedBytes = 0

  constructor(private readonly options: {
    binding: Readonly<DeviceSessionBinding>
    extensions: DeviceNegotiatedExtension[]
    registrations: TestWorkerExtension[]
    send(frame: DeviceApplicationFrame): void
    observe(operation: TestWorkerOperation): void
    fail(error: Error): void
  }) {}

  private extension(namespace: string, direction: 'incoming' | 'outgoing') {
    const extension = this.options.extensions.find(entry => entry.namespace === namespace)
    const allowed = direction === 'incoming' ? extension?.mainCanRequest : extension?.workerCanRequest
    if (!extension || !allowed) throw new Error(`The worker ${direction} extension is unavailable: ${namespace}.`)
    return extension
  }

  async request(namespace: string, payload: unknown, options: { bytes?: Uint8Array; signal?: AbortSignal } = {}) {
    this.lifetime.signal.throwIfAborted()
    if (this.pending.size >= DEVICE_APPLICATION_IN_FLIGHT) throw new Error('The test worker has too many active requests.')
    const extension = this.extension(namespace, 'outgoing')
    const id = randomUUID()
    const response = deferred<DeviceApplicationResult>()
    this.pending.set(id, response)
    const signal = options.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal
    try {
      await this.sendPacket(id, extension, 'request', { payload, ...(options.bytes ? { bytes: options.bytes } : {}) }, signal)
      return await withWorkerDeadline(response.promise, signal)
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.options.send({ type: 'application-cancel', id })
      throw error
    } finally { this.pending.delete(id) }
  }

  private async sendAcknowledged(frame: DeviceApplicationFrame, offset: number, signal: AbortSignal) {
    const key = `${frame.id}:${offset}`
    const receipt = deferred<void>()
    this.acknowledgements.set(key, receipt)
    try {
      this.options.send(frame)
      await withWorkerDeadline(receipt.promise, signal)
    } finally { this.acknowledgements.delete(key) }
  }

  private async sendPacket(id: string, extension: DeviceNegotiatedExtension, kind: OpenFrame['kind'],
    result: DeviceApplicationResult, signal: AbortSignal) {
    const json = Buffer.from(JSON.stringify(result.payload ?? null))
    const bytes = result.bytes ? Buffer.from(result.bytes) : Buffer.alloc(0)
    if (json.byteLength > extension.maxJsonBytes || bytes.byteLength > extension.maxBinaryBytes) {
      throw new Error('The test worker response exceeds the negotiated protocol bound.')
    }
    await this.sendAcknowledged({ type: 'application-open', id, namespace: extension.namespace,
      version: extension.version, kind, jsonBytes: json.byteLength, binaryBytes: bytes.byteLength }, 0, signal)
    const packet = Buffer.concat([json, bytes])
    for (let offset = 0; offset < packet.byteLength; offset += DEVICE_APPLICATION_CHUNK_BYTES) {
      const chunk = packet.subarray(offset, offset + DEVICE_APPLICATION_CHUNK_BYTES)
      await this.sendAcknowledged({ type: 'application-chunk', id, offset, data: chunk.toString('base64') },
        offset + chunk.byteLength, signal)
    }
  }

  receive(frame: DeviceApplicationFrame): void {
    this.lifetime.signal.throwIfAborted()
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(frame.id)) {
      throw new Error('The device application frame has no valid request ID.')
    }
    if (frame.type === 'application-ack') {
      if (!Number.isSafeInteger(frame.offset) || frame.offset < 0) throw new Error('Invalid device chunk acknowledgement.')
      this.acknowledgements.get(`${frame.id}:${frame.offset}`)?.resolve()
      return
    }
    if (frame.type === 'application-cancel' || frame.type === 'application-reject') {
      const error = new Error(frame.type === 'application-cancel' ? 'Peer canceled the worker operation.' : 'Peer rejected worker capacity.')
      this.pending.get(frame.id)?.reject(error)
      this.operations.get(frame.id)?.abort(error)
      for (const [key, receipt] of this.acknowledgements) if (key.startsWith(frame.id + ':')) receipt.reject(error)
      this.release(frame.id)
      return
    }
    if (frame.type === 'application-open') { this.open(frame); return }
    if (frame.type !== 'application-chunk') throw new Error('Unsupported device application frame.')
    this.chunk(frame)
  }

  private open(frame: OpenFrame) {
    const extension = this.options.extensions.find(entry => entry.namespace === frame.namespace)
    if (!extension || extension.version !== frame.version || !['request', 'response', 'error'].includes(frame.kind)
      || !Number.isSafeInteger(frame.jsonBytes) || frame.jsonBytes < 1 || frame.jsonBytes > extension.maxJsonBytes
      || !Number.isSafeInteger(frame.binaryBytes) || frame.binaryBytes < 0 || frame.binaryBytes > extension.maxBinaryBytes
      || this.assemblies.has(frame.id) || this.operations.has(frame.id)) throw new Error('Invalid device application envelope.')
    if (frame.kind === 'request') this.extension(frame.namespace, 'incoming')
    else if (!this.pending.has(frame.id)) { this.options.send({ type: 'application-cancel', id: frame.id }); return }
    const length = frame.jsonBytes + frame.binaryBytes
    if (this.reservedBytes + length > DEVICE_APPLICATION_BUFFER_BYTES
      || this.assemblies.size + this.operations.size >= DEVICE_APPLICATION_IN_FLIGHT) {
      this.options.send({ type: 'application-reject', id: frame.id, code: 'backpressure' })
      return
    }
    this.reservedBytes += length
    this.assemblies.set(frame.id, { frame, received: 0, chunks: [], lifetime: new AbortController() })
    this.options.send({ type: 'application-ack', id: frame.id, offset: 0 })
  }

  private chunk(frame: Extract<DeviceApplicationFrame, { type: 'application-chunk' }>) {
    const assembly = this.assemblies.get(frame.id)
    if (!assembly) { this.options.send({ type: 'application-cancel', id: frame.id }); return }
    if (frame.offset !== assembly.received || typeof frame.data !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
      throw new Error('Invalid device application chunk offset or encoding.')
    }
    const bytes = Buffer.from(frame.data, 'base64')
    const total = assembly.frame.jsonBytes + assembly.frame.binaryBytes
    if (!bytes.byteLength || bytes.byteLength > DEVICE_APPLICATION_CHUNK_BYTES
      || assembly.received + bytes.byteLength > total) throw new Error('Invalid device application chunk size.')
    assembly.chunks.push(bytes)
    assembly.received += bytes.byteLength
    this.options.send({ type: 'application-ack', id: frame.id, offset: assembly.received })
    if (assembly.received !== total) return
    this.assemblies.delete(frame.id)
    this.reservedBytes -= total
    const task = this.complete(assembly)
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), error => {
      this.tasks.delete(task)
      if (!this.lifetime.signal.aborted) this.options.fail(error instanceof Error ? error : new Error('Worker response delivery failed.'))
    })
  }

  private async complete(assembly: Assembly) {
    const { frame } = assembly
    const packet = Buffer.concat(assembly.chunks)
    const payload: unknown = JSON.parse(packet.subarray(0, frame.jsonBytes).toString('utf8'))
    const result: DeviceApplicationResult = { payload,
      ...(frame.binaryBytes ? { bytes: packet.subarray(frame.jsonBytes) } : {}) }
    if (frame.kind !== 'request') {
      const pending = this.pending.get(frame.id)
      if (frame.kind === 'error') pending?.reject(Object.assign(new Error('The main rejected the worker operation.'), { failure: payload }))
      else pending?.resolve(result)
      return
    }
    const signal = AbortSignal.any([assembly.lifetime.signal, this.lifetime.signal])
    this.operations.set(frame.id, assembly.lifetime)
    const operation: TestWorkerOperation = { id: frame.id, namespace: frame.namespace, payload,
      ...(result.bytes ? { bytes: result.bytes } : {}), binding: this.options.binding, signal }
    this.options.observe(operation)
    const extension = this.extension(frame.namespace, 'incoming')
    try {
      let response: DeviceApplicationResult
      let kind: 'response' | 'error' = 'response'
      try {
        const handler = this.options.registrations.find(entry => entry.namespace === frame.namespace)?.handle
        if (!handler) throw new Error('No scripted handler is installed for this worker operation.')
        response = await handler(operation)
      } catch (error) {
        if (signal.aborted) return
        if (!(error instanceof TestWorkerOperationError)) throw error
        response = { payload: error.failure }
        kind = 'error'
      }
      if (!signal.aborted) await this.sendPacket(frame.id, extension, kind, response, signal)
    }
    finally { this.operations.delete(frame.id); assembly.lifetime.abort() }
  }

  private release(id: string) {
    const assembly = this.assemblies.get(id)
    if (!assembly) return
    this.reservedBytes -= assembly.frame.jsonBytes + assembly.frame.binaryBytes
    assembly.lifetime.abort()
    this.assemblies.delete(id)
  }

  async close(error = new Error('The test worker channel closed.')) {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(error)
    for (const pending of this.pending.values()) pending.reject(error)
    for (const pending of this.acknowledgements.values()) pending.reject(error)
    for (const assembly of this.assemblies.values()) assembly.lifetime.abort(error)
    for (const operation of this.operations.values()) operation.abort(error)
    this.pending.clear()
    this.acknowledgements.clear()
    this.assemblies.clear()
    this.reservedBytes = 0
    const settled = await Promise.allSettled(this.tasks)
    const failures = settled.flatMap(result => result.status === 'rejected' && result.reason !== error ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Worker operations failed while the owned channel closed.')
  }
}
