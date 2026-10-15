import { AsyncLocalStorage } from 'node:async_hooks'
import {
  DEVICE_APPLICATION_IN_FLIGHT, DEVICE_APPLICATION_STOP_IN_FLIGHT,
  type DeviceRequestPriority,
} from '@foreman-code/contracts/device-application'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from './deviceApplicationError.js'

export const deviceForegroundWaitMs = 45_000
/** Slots that bulk transfers never take, so short calls (relay, status, control) are admitted while pages and logs stream. */
const interactiveSlotReserve = 4

interface RequestSlot {
  priority: DeviceRequestPriority
  stop: boolean
  bulk?: boolean
  namespace?: string
}
interface WaitingRequest {
  bulk: boolean
  admit(): void
  reject(error: Error): void
}
export interface DeviceRequestSlotSnapshot {
  active: number
  bulk: number
  waiting: number
  byNamespace: Record<string, number>
}

/** Background work leaves one slot available and yields to queued foreground requests; a long foreground request in flight does not starve it. */
export class DeviceRequestQueue {
  private active = 0
  private bulkActive = 0
  private foreground = 0
  private stops = 0
  private readonly waiting: WaitingRequest[] = []
  private readonly namespaces = new Map<string, number>()
  private failure: Error | undefined

  get busy(): boolean {
    return this.waiting.length > 0 || this.active >= DEVICE_APPLICATION_IN_FLIGHT - 1
  }

  snapshot(): DeviceRequestSlotSnapshot {
    return { active: this.active, bulk: this.bulkActive, waiting: this.waiting.length, byNamespace: Object.fromEntries(this.namespaces) }
  }

  async acquire({ priority, stop, bulk = false, namespace = 'unlabeled', signal }: RequestSlot & { signal?: AbortSignal | undefined }): Promise<() => void> {
    if (this.failure) throw this.failure
    if (signal?.aborted) throw new DeviceApplicationError('cancelled')
    if (stop) {
      if (this.stops >= DEVICE_APPLICATION_STOP_IN_FLIGHT) throw new DeviceApplicationAdmissionError()
      return this.reserve({ priority, stop, bulk, namespace })
    }
    if (priority === 'background') {
      if (this.busy) throw new DeviceApplicationAdmissionError('background_yield')
      return this.reserve({ priority, stop, bulk, namespace })
    }
    if (this.canAdmit(bulk) && !this.waiting.some(waiter => waiter.bulk === bulk)) return this.reserve({ priority, stop, bulk, namespace })
    if (this.waiting.length >= 64) throw new DeviceApplicationAdmissionError('admission_queue_full')
    return new Promise<() => void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
      }
      const waiter: WaitingRequest = {
        bulk,
        admit: () => { cleanup(); resolve(this.reserve({ priority, stop, bulk, namespace })) },
        reject: error => { cleanup(); reject(error); this.drain() },
      }
      const cancel = () => waiter.reject(new DeviceApplicationError('cancelled'))
      const timer = setTimeout(() => waiter.reject(new DeviceApplicationAdmissionError('admission_queue_timeout')),
        deviceForegroundWaitMs)
      this.waiting.push(waiter)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  private canAdmit(bulk: boolean): boolean {
    return this.active < DEVICE_APPLICATION_IN_FLIGHT && (!bulk || this.bulkActive < DEVICE_APPLICATION_IN_FLIGHT - interactiveSlotReserve)
  }

  private reserve({ priority, stop, bulk, namespace }: Required<RequestSlot>): () => void {
    if (stop) this.stops++
    else this.active++
    if (!stop && bulk) this.bulkActive++
    if (!stop && priority === 'foreground') this.foreground++
    this.namespaces.set(namespace, (this.namespaces.get(namespace) ?? 0) + 1)
    return () => {
      if (stop) this.stops--
      else this.active--
      if (!stop && bulk) this.bulkActive--
      if (!stop && priority === 'foreground') this.foreground--
      const remaining = (this.namespaces.get(namespace) ?? 1) - 1
      if (remaining) this.namespaces.set(namespace, remaining)
      else this.namespaces.delete(namespace)
      this.drain()
    }
  }

  private drain(): void {
    if (this.failure) return
    for (const waiter of [...this.waiting]) if (this.canAdmit(waiter.bulk)) waiter.admit()
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

/** Binary transfers, native history pages and CI log reads hold a slot for many round trips. */
export function deviceRequestIsBulk(namespace: string, payload: unknown, hasBytes: boolean): boolean {
  if (hasBytes) return true
  const fields = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  return namespace === 'execution-v1' && fields.method === 'history' || namespace === 'ci-host-v1' && fields.operation === 'read'
}
