import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { CI_HOST_NAMESPACE } from '@foreman-code/contracts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { deferred } from '../../../test/helpers/deferred.js'
import { DeviceApplicationChannel } from './deviceApplicationChannel.js'
import { adaptDeviceSocket } from './deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

it('delivers validated CI cancellation while ordinary requests occupy both peers', async () => {
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const extension = { namespace: CI_HOST_NAMESPACE, version: 1, mainCanRequest: true, workerCanRequest: false,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const mainRaw = new Socket()
  const workerRaw = new Socket()
  mainRaw.peer = workerRaw
  workerRaw.peer = mainRaw
  const mainSocket = adaptDeviceSocket(mainRaw)
  const workerSocket = adaptDeviceSocket(workerRaw)
  const released = deferred()
  const handled = vi.fn(async (payload: unknown) => {
    if ((payload as { operation: string }).operation !== 'cancel') await released.promise
    return { payload }
  })
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket,
    signal: new AbortController().signal, extensions: [extension], registrations: [] })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket,
    signal: new AbortController().signal, extensions: [extension],
    registrations: [{ ...extension, role: 'server', handle: handled }] })
  const carriers = [main.run(mainSocket.messages[Symbol.asyncIterator](), 15_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 15_000)]
  const carrierResults = Promise.allSettled(carriers)
  const requests: Promise<unknown>[] = []
  try {
    requests.push(...Array.from({ length: 8 }, () => main.request(CI_HOST_NAMESPACE, { operation: 'status' }, { priority: 'foreground' })))
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(8))
    const invalid = { operation: 'cancel', runId: 'invalid' }
    requests.push(main.request(CI_HOST_NAMESPACE, invalid))
    const request = { operation: 'cancel', runId: randomUUID() }
    const canceling = main.request(CI_HOST_NAMESPACE, request)
    requests.push(canceling)
    await vi.waitFor(() => expect(handled.mock.calls.map(([payload]) => payload)).toContainEqual(request))
    expect(handled.mock.calls.map(([payload]) => payload)).not.toContainEqual(invalid)
    await expect(canceling).resolves.toEqual({ payload: request })
    released.resolve()
    await Promise.all(requests)
    expect(handled.mock.calls.map(([payload]) => payload)).toContainEqual(invalid)
  } finally {
    released.resolve()
    main.close()
    worker.close()
    await Promise.all([carrierResults, Promise.allSettled(requests), main.join(), worker.join()])
    mainSocket.close()
    workerSocket.close()
  }
})
