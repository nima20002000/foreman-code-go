import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { negotiateDeviceExtensions } from '@graphql/contracts/device-application'
import { DeviceApplicationChannel, extensionDescriptors, type DeviceExtensionRegistration } from '../src/modules/devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  frames: string[] = []
  send(text: string) { this.frames.push(text); queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false) }) }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); this.peer?.close() }
}
const binding = { mainId: 'main', deviceId: 'device', workerInstallationId: 'installation', keyRevision: 1, authorizationRevision: 1, bootId: 'boot', connectionEpoch: 'epoch', connectionGeneration: 1 }
const flush = async () => { for (let i = 0; i < 160; i++) await Promise.resolve() }
function setup(handler: NonNullable<DeviceExtensionRegistration['handle']>, limits = { maxJsonBytes: 1_048_576, maxBinaryBytes: 1_048_576 }, heartbeatMs = 1000, mainHandler?: NonNullable<DeviceExtensionRegistration['handle']>) {
  const rawMain = new Socket(), rawWorker = new Socket(); rawMain.peer = rawWorker; rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain), workerSocket = adaptDeviceSocket(rawWorker)
  const mainRegistration: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1, role: mainHandler ? 'duplex' : 'client', ...limits, ...(mainHandler ? { handle: mainHandler } : {}) }
  const workerRegistration: DeviceExtensionRegistration = { ...mainRegistration, role: mainHandler ? 'duplex' : 'server', handle: handler }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([mainRegistration]), extensionDescriptors([workerRegistration]))
  const parent = new AbortController(), revalidate = vi.fn(async () => {})
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket, signal: parent.signal, extensions, registrations: [mainRegistration], revalidate })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket, signal: parent.signal, extensions, registrations: [workerRegistration] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), heartbeatMs * 2), worker.run(workerSocket.messages[Symbol.asyncIterator](), heartbeatMs)]
  for (const task of tasks) void task.catch(() => {})
  return { main, worker, rawMain, rawWorker, revalidate, close: async () => { parent.abort(); main.close(); worker.close(); await Promise.allSettled(tasks) } }
}
afterEach(() => vi.useRealTimers())
describe('authenticated namespace carrier mechanics', () => {
  it('requires actual server handler and exact role/version-compatible negotiation', () => {
    expect(() => extensionDescriptors([{ namespace: 'execution-v1', version: 1, role: 'server', maxJsonBytes: 1024, maxBinaryBytes: 0 }])).toThrow('actual domain handler')
    const client = { namespace: 'execution-v1', version: 1, role: 'client' as const, maxJsonBytes: 1024, maxBinaryBytes: 0 }
    expect(negotiateDeviceExtensions([client], [{ ...client, role: 'server', version: 2 }])).toEqual([])
    expect(negotiateDeviceExtensions([client], [client])).toEqual([])
    expect(negotiateDeviceExtensions([client], [{ ...client, role: 'server' }])).toEqual([{ namespace: 'execution-v1', version: 1, mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 1024, maxBinaryBytes: 0 }])
  })
  it('correlates bounded chunked JSON plus full 1MiB binary with actual handler receipt', async () => {
    const bytes = Uint8Array.from({ length: 1_048_576 }, (_, index) => index % 256), observed = vi.fn()
    const pair = setup(async (payload, context) => { observed(context); return { payload, ...(context.bytes ? { bytes: context.bytes } : {}) } })
    try {
      const response = await pair.main.request('execution-v1', { text: 'payload'.repeat(20_000) }, { bytes })
      expect(response.payload).toEqual({ text: 'payload'.repeat(20_000) }); expect(Buffer.from(response.bytes!).equals(Buffer.from(bytes))).toBe(true)
      expect(observed.mock.calls[0]![0].binding).toEqual(binding); expect(Object.isFrozen(observed.mock.calls[0]![0].binding)).toBe(true)
      expect(pair.rawMain.frames.every((frame) => Buffer.byteLength(frame) <= 16_384)).toBe(true)
      expect(pair.revalidate).toHaveBeenCalled()
    } finally { await pair.close() }
  })
  it('chunk ACK is not execution acceptance or completion', async () => {
    let release!: () => void; const entered = vi.fn()
    const pair = setup(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }); return { payload: { accepted: true } } })
    try {
      let settled = false; const result = pair.main.request('execution-v1', { dispatch: true }).then((value) => { settled = true; return value })
      await flush(); expect(entered).toHaveBeenCalled(); expect(settled).toBe(false)
      release(); expect((await result).payload).toEqual({ accepted: true })
    } finally { await pair.close() }
  })
  it('domain handler denies insufficient scoped grants without acquiring authority', async () => {
    const launched = vi.fn()
    const pair = setup(async (payload) => { if ((payload as { grant?: string }).grant !== 'exact-operation') throw { code: 'forbidden' }; launched(); return { payload: 'receipt' } })
    try {
      await expect(pair.main.request('execution-v1', { grant: 'device-heartbeat-only' })).rejects.toThrow('forbidden')
      expect(launched).not.toHaveBeenCalled()
      await expect(pair.main.request('execution-v1', { grant: 'exact-operation' })).resolves.toEqual({ payload: 'receipt' })
      expect(launched).toHaveBeenCalledOnce()
    } finally { await pair.close() }
  })
  it('cancellation fences a late noncooperative handler response and releases its slot', async () => {
    let finish!: (value: { payload: unknown }) => void; let handlerSignal!: AbortSignal
    const pair = setup(async (payload, context) => { if (payload === 'slow') { handlerSignal = context.signal; return new Promise((resolve) => { finish = resolve }) }; return { payload } })
    try {
      const abort = new AbortController(), result = pair.main.request('execution-v1', 'slow', { signal: abort.signal }); void result.catch(() => {})
      await flush(); abort.abort(); await expect(result).rejects.toThrow('cancelled'); await flush(); expect(handlerSignal.aborted).toBe(true)
      finish({ payload: 'stale' }); await flush()
      expect(await pair.main.request('execution-v1', 'fresh')).toEqual({ payload: 'fresh' })
    } finally { await pair.close() }
  })
  it('connection revocation rejects pending requests and fences handler generations', async () => {
    let handlerSignal!: AbortSignal
    const pair = setup(async (_payload, context) => { handlerSignal = context.signal; return new Promise(() => {}) })
    const result = pair.main.request('execution-v1', 'pending'); void result.catch(() => {})
    await flush(); await pair.close(); await expect(result).rejects.toThrow(); expect(handlerSignal.aborted).toBe(true)
    await expect(pair.main.request('execution-v1', 'stale')).rejects.toThrow()
  })
  it('rejects oversized request and reply explicitly without truncation or losing heartbeat', async () => {
    const handler = vi.fn(async (payload: unknown) => ({ payload: payload === 'large-reply' ? 'x'.repeat(2000) : payload }))
    const pair = setup(handler, { maxJsonBytes: 1024, maxBinaryBytes: 0 })
    try {
      await expect(pair.main.request('execution-v1', 'x'.repeat(2000))).rejects.toThrow('payload-too-large'); expect(handler).not.toHaveBeenCalled()
      await expect(pair.main.request('execution-v1', 'large-reply')).rejects.toThrow('payload-too-large')
      expect(await pair.main.request('execution-v1', 'small')).toEqual({ payload: 'small' })
      await expect(pair.main.request('unknown-v1', {})).rejects.toThrow('unavailable')
      await expect(pair.worker.request('execution-v1', {})).rejects.toThrow('unavailable')
    } finally { await pair.close() }
  })
  it('keeps heartbeat/control progress independent from a blocked domain handler', async () => {
    vi.useFakeTimers(); let release!: () => void
    const pair = setup(async () => { await new Promise<void>((resolve) => { release = resolve }); return { payload: null } }, undefined, 100)
    try {
      const result = pair.main.request('execution-v1', 'pending'); await flush()
      await vi.advanceTimersByTimeAsync(450)
      expect(pair.rawMain.frames.filter((frame) => JSON.parse(frame).type === 'pong').length).toBeGreaterThan(3)
      release(); expect(await result).toEqual({ payload: null })
    } finally { await pair.close(); expect(vi.getTimerCount()).toBe(0) }
  })
  it('times out a slow chunk reader without mistaking queued bytes for handler admission', async () => {
    vi.useFakeTimers(); const handler = vi.fn(async () => ({ payload: 'receipt' })), pair = setup(handler)
    const send = pair.rawWorker.send.bind(pair.rawWorker)
    pair.rawWorker.send = (text) => { if (JSON.parse(text).type !== 'application-ack') send(text) }
    try {
      const pending = pair.main.request('execution-v1', { dispatch: true }); void pending.catch(() => {})
      await flush(); await vi.advanceTimersByTimeAsync(10_001); await expect(pending).rejects.toThrow('timeout')
      expect(handler).not.toHaveBeenCalled(); await flush(); pair.rawWorker.send = send
      expect(await pair.main.request('execution-v1', { dispatch: true })).toEqual({ payload: 'receipt' })
    } finally { await pair.close(); expect(vi.getTimerCount()).toBe(0) }
  })
  it('bounds concurrent requests even across awaited live authorization', async () => {
    const pair = setup(async () => new Promise(() => {}))
    const requests = Array.from({ length: 8 }, () => pair.main.request('execution-v1', {})); for (const request of requests) void request.catch(() => {})
    await flush(); await expect(pair.main.request('execution-v1', {})).rejects.toThrow('backpressure'); await pair.close(); await Promise.allSettled(requests)
  })
  it.each(['main', 'worker'] as const)('delivers duplex replies on %s with all inbound request slots occupied', async (side) => {
    const entered = vi.fn(), releases: Array<() => void> = []
    const slow: NonNullable<DeviceExtensionRegistration['handle']> = async () => {
      entered(); await new Promise<void>((resolve) => { releases.push(resolve) }); return { payload: 'released' }
    }
    const fast: NonNullable<DeviceExtensionRegistration['handle']> = async (payload) => {
      if (payload === 'deny') throw { code: 'forbidden' }
      return { payload: 'reply' }
    }
    const pair = setup(side === 'worker' ? slow : fast, undefined, 1000, side === 'main' ? slow : fast)
    const occupied = side === 'main' ? pair.main : pair.worker, caller = side === 'main' ? pair.worker : pair.main
    const requests = Array.from({ length: 8 }, () => caller.request('execution-v1', {}))
    for (const request of requests) void request.catch(() => {})
    try {
      await flush(); expect(entered).toHaveBeenCalledTimes(8)
      await expect(caller.request('execution-v1', {})).rejects.toThrow('backpressure')
      await expect(occupied.request('execution-v1', {})).resolves.toEqual({ payload: 'reply' })
      await expect(occupied.request('execution-v1', 'deny')).rejects.toThrow('forbidden')
      expect(pair.rawMain.closed).toBe(false); expect(pair.rawWorker.closed).toBe(false)
      for (const release of releases) release()
      expect(await Promise.all(requests)).toEqual(Array.from({ length: 8 }, () => ({ payload: 'released' })))
    } finally { await pair.close(); await Promise.allSettled(requests) }
  })
  it.each([
    ['request slots', 8, 2, 0],
    ['total bytes', 2, 1_048_576, 1_048_576],
  ] as const)('retains the inbound %s limit before acknowledging another packet', async (_name, admitted, jsonBytes, binaryBytes) => {
    const handler = vi.fn(async () => ({ payload: null })), pair = setup(handler)
    const open = (index: number) => pair.rawMain.send(JSON.stringify({ type: 'application-open', id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, namespace: 'execution-v1', version: 1, kind: 'request', jsonBytes, binaryBytes }))
    try {
      for (let index = 0; index < admitted; index++) open(index)
      await flush(); expect(pair.rawWorker.closed).toBe(false)
      expect(pair.rawWorker.frames.filter((frame) => JSON.parse(frame).type === 'application-ack')).toHaveLength(admitted)
      open(admitted); await flush(); expect(pair.rawWorker.closed).toBe(true)
      expect(pair.rawWorker.frames.filter((frame) => JSON.parse(frame).type === 'application-ack')).toHaveLength(admitted)
      expect(handler).not.toHaveBeenCalled()
    } finally { await pair.close() }
  })
  it('rejects malformed offsets after upgrade without admitting a handler', async () => {
    const handler = vi.fn(async () => ({ payload: null })), pair = setup(handler)
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    pair.rawMain.send(JSON.stringify({ type: 'application-open', id, namespace: 'execution-v1', version: 1, kind: 'request', jsonBytes: 2, binaryBytes: 0 })); await flush()
    pair.rawMain.send(JSON.stringify({ type: 'application-chunk', id, offset: 1, data: Buffer.from('{}').toString('base64') })); await flush()
    expect(handler).not.toHaveBeenCalled(); expect(pair.rawWorker.closed).toBe(true); await pair.close()
  })
})
