import { AsyncLocalStorage } from 'node:async_hooks'
import {
  DEVICE_APPLICATION_IN_FLIGHT, DEVICE_APPLICATION_STOP_IN_FLIGHT,
  type DeviceRequestPriority,
} from '@foreman-code/contracts/device-application'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from './deviceApplicationError.js'

export const deviceForegroundWaitMs = 45_000

interface RequestSlot {
  priority: DeviceRequestPriority
  stop: boolean
}
interface WaitingRequest {
  admit(): void
  reject(error: Error): void
}

/** Background work leaves one slot available and yields to queued foreground requests. */
export class DeviceRequestQueue {
  private active = 0
  private foreground = 0
  private stops = 0
  private readonly waiting: WaitingRequest[] = []
  private failure: Error | undefined

  get busy(): boolean {
    return this.foreground > 0 || this.waiting.length > 0 || this.active >= DEVICE_APPLICATION_IN_FLIGHT - 1
  }

  async acquire({ priority, stop, signal }: RequestSlot & { signal?: AbortSignal | undefined }): Promise<() => void> {
    if (this.failure) throw this.failure
    if (signal?.aborted) throw new DeviceApplicationError('cancelled')
    if (stop) {
      if (this.stops >= DEVICE_APPLICATION_STOP_IN_FLIGHT) throw new DeviceApplicationAdmissionError()
      return this.reserve({ priority, stop })
    }
    if (priority === 'background') {
      if (this.busy) throw new DeviceApplicationAdmissionError('background_yield')
      return this.reserve({ priority, stop })
    }
    if (this.active < DEVICE_APPLICATION_IN_FLIGHT && !this.waiting.length) return this.reserve({ priority, stop })
    if (this.waiting.length >= 64) throw new DeviceApplicationAdmissionError('admission_queue_full')
    return new Promise<() => void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
      }
      const waiter: WaitingRequest = {
        admit: () => { cleanup(); resolve(this.reserve({ priority, stop })) },
        reject: error => { cleanup(); reject(error); this.drain() },
      }
      const cancel = () => waiter.reject(new DeviceApplicationError('cancelled'))
      const timer = setTimeout(() => waiter.reject(new DeviceApplicationAdmissionError('admission_queue_timeout')),
        deviceForegroundWaitMs)
      this.waiting.push(waiter)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  private reserve({ priority, stop }: RequestSlot): () => void {
    if (stop) this.stops++
    else this.active++
    if (!stop && priority === 'foreground') this.foreground++
    return () => {
      if (stop) this.stops--
      else this.active--
      if (!stop && priority === 'foreground') this.foreground--
      this.drain()
    }
  }

  private drain(): void {
    if (this.failure) return
    while (this.active < DEVICE_APPLICATION_IN_FLIGHT && this.waiting.length) this.waiting[0]!.admit()
  }

  close(error: Error): void {
    this.failure = error
    for (const request of [...this.waiting]) request.reject(error)
  }
}

const foregroundWork = new AsyncLocalStorage<true>()

/** Device requests made while serving an Operator or Agent tool call are foreground, whatever their namespace. */
export function asForegroundWork<T>(work: () => Promise<T>): Promise<T> {
  return foregroundWork.run(true, work)
}

export function effectiveDeviceRequestPriority(namespace: string, payload: unknown,
  explicit?: DeviceRequestPriority): DeviceRequestPriority {
  return explicit ?? (foregroundWork.getStore() ? 'foreground' : deviceRequestPriority(namespace, payload))
}

export function deviceRequestPriority(namespace: string, payload: unknown): DeviceRequestPriority {
  const operation = payload && typeof payload === 'object' && 'operation' in payload ? payload.operation : undefined
  if (namespace === 'host-harness-check-v1' && operation === 'operator-configuration-inspect') return 'foreground'
  if (['harness-discovery-v1', 'host-harness-check-v1', 'resource-telemetry'].includes(namespace)) return 'background'
  if (operation === 'status' && ['ci-host-v1', 'computer-maintenance-v2'].includes(namespace)) return 'background'
  return 'foreground'
}
