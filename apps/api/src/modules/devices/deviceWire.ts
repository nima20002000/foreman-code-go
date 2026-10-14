import { DEVICE_BUFFER_BYTES, DEVICE_FRAME_BYTES, DEVICE_QUEUE_DEPTH, type DeviceFrame } from '@foreman-code/contracts/device-connection'

export class DeviceConnectionError extends Error {
  readonly code: import('@foreman-code/contracts/device-connection').DeviceFailureCode

  constructor(code: import('@foreman-code/contracts/device-connection').DeviceFailureCode) {
    super(code)
    this.code = code
  }
}
/** Adapter must install message/error/close handlers synchronously, before returning. */
export interface DeviceSocket {
  readonly messages: AsyncIterable<string>
  readonly bufferedAmount: number
  send(frame: string): void
  close(): void
}
export function sendFrame(socket: DeviceSocket, frame: DeviceFrame) {
  const text = JSON.stringify(frame)
  if (Buffer.byteLength(text) > DEVICE_FRAME_BYTES || socket.bufferedAmount + Buffer.byteLength(text) > DEVICE_BUFFER_BYTES) throw new DeviceConnectionError('backpressure')
  socket.send(text)
}
export function readFrame(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > DEVICE_FRAME_BYTES) throw new DeviceConnectionError('malformed-frame')
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new DeviceConnectionError('malformed-frame') }
}
/** Structural ws boundary: no compression or server/listener ownership in the core. */
export interface RawDeviceSocket {
  bufferedAmount: number
  on(event: 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): void
  off(event: 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): void
  send(text: string): void
  close(): void
}
export function adaptDeviceSocket(raw: RawDeviceSocket): DeviceSocket {
  const queue: string[] = []
  let queuedBytes = 0
  let ended = false
  let failure: Error | undefined
  let terminalFailure: DeviceConnectionError | undefined
  let wake: (() => void) | undefined
  const cleanup = () => { raw.off('message', message); raw.off('error', error); raw.off('close', close) }
  const finish = (cause?: Error) => { if (ended) return; ended = true; failure = cause; queue.length = 0; queuedBytes = 0; wake?.() }
  const close = () => { finish(terminalFailure); cleanup() }
  const error = () => { finish(new DeviceConnectionError('transport')); raw.close() }
  const message = (data: unknown, binary: unknown) => {
    if (ended) return
    if (binary === true || (!Buffer.isBuffer(data) && typeof data !== 'string')) { finish(new DeviceConnectionError('malformed-frame')); raw.close(); return }
    const text = String(data)
    if (Buffer.byteLength(text) > DEVICE_FRAME_BYTES || queue.length >= DEVICE_QUEUE_DEPTH || queuedBytes + Buffer.byteLength(text) > DEVICE_BUFFER_BYTES) { finish(new DeviceConnectionError('backpressure')); raw.close(); return }
    if (text.includes('blocked')) {
      try { const frame = JSON.parse(text) as { type?: string; code?: string }; if (frame.type === 'blocked') terminalFailure = new DeviceConnectionError(['authentication', 'revoked', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame', 'backpressure', 'timeout', 'transport'].includes(frame.code ?? '') ? frame.code as import('@foreman-code/contracts/device-connection').DeviceFailureCode : 'malformed-frame') } catch { /* ignore: parser reports malformed JSON at consumption */ }
    }
    queue.push(text); queuedBytes += Buffer.byteLength(text); wake?.()
  }
  raw.on('message', message); raw.on('error', error); raw.on('close', close)
  return {
    get bufferedAmount() { return raw.bufferedAmount },
    send(text) { if (ended) throw new DeviceConnectionError('transport'); raw.send(text) },
    close() { finish(); raw.close() },
    messages: { async *[Symbol.asyncIterator]() {
      try {
        while (!ended) {
          if (queue.length) { const text = queue.shift()!; queuedBytes -= Buffer.byteLength(text); yield text; continue }
          await new Promise<void>((resolve) => { wake = resolve }); wake = undefined
        }
        if (failure) throw failure
      } finally { finish(); raw.close() }
    } },
  }
}
export async function nextFrame(iterator: AsyncIterator<string>, signal: AbortSignal, deadlineMs: number) {
  if (signal.aborted) throw new DeviceConnectionError('transport')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeviceConnectionError('timeout')), deadlineMs)
        abort = () => reject(new DeviceConnectionError('transport'))
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
}

export async function withDeviceDeadline<T>(operation: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  if (signal.aborted) throw new DeviceConnectionError('transport')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeviceConnectionError('timeout')), ms)
      abort = () => reject(new DeviceConnectionError('transport'))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
}
