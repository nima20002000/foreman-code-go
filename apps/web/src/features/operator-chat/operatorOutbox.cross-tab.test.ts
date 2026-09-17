// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const epochKey = 'graphql.identity-epoch'
const lockName = 'graphql.operator-outbox.v1'
const key = (epoch = 'epoch-a') => `graphql.chat:${epoch}:outbox:conversation-one`
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
/** Shared browser service; each imported outbox module below is an independent tab. */
function browserLocks() {
  const tails = new Map<string, Promise<unknown>>()
  return {
    request<T>(name: string, options: LockOptions, callback: (lock: Lock) => T | PromiseLike<T>): Promise<T> {
      const work = (tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(() => {
        options.signal?.throwIfAborted()
        return callback({ name, mode: 'exclusive' } as Lock)
      })
      tails.set(name, work)
      return work
    },
  }
}
async function tab() {
  vi.resetModules()
  return import('./operatorOutbox')
}
let locks: ReturnType<typeof browserLocks>
let originalLocks: PropertyDescriptor | undefined
let nextId: number
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem(epochKey, 'epoch-a')
  nextId = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` as ReturnType<Crypto['randomUUID']>)
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  locks = browserLocks()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
  window.localStorage.clear()
})

describe('F12: cross-tab durable Operator reservations', () => {
  it('generates no identity until the browser-wide lock is acquired and shares the winner across two tabs', async () => {
    const first = await tab(), second = await tab(), hold = gate()
    const held = locks.request(lockName, {}, () => hold.promise)
    const a = first.reserveOperatorMessage('conversation-one', 'Run the check.', '/original-route')
    const b = second.reserveOperatorMessage('conversation-one', 'Run the check.', '/different-route')
    await Promise.resolve()
    expect(nextId).toBe(0)
    expect(window.localStorage.getItem(key())).toBeNull()
    hold.resolve(); await held
    const [left, right] = await Promise.all([a, b])
    expect(right).toEqual(left)
    expect(right.context?.route).toBe('/original-route')
    expect(nextId).toBe(1)
    expect(JSON.parse(window.localStorage.getItem(key())!)).toEqual(left)
  })

  it('reproduces the competing empty-read race without allowing a losing request to be submitted', async () => {
    const first = await tab(), second = await tab()
    const read = Storage.prototype.getItem
    let competing: ReturnType<typeof second.reserveOperatorMessage> | undefined
    let injected = false
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, storageKey: string) {
      const value = read.call(this, storageKey)
      if (storageKey === key() && value === null && !injected) {
        injected = true
        // Another tab attempts a reservation between the first tab's read and write.
        competing = second.reserveOperatorMessage('conversation-one', 'Different command.', '/tab-b')
        void competing.catch(() => undefined)
      }
      return value
    })
    const winner = await first.reserveOperatorMessage('conversation-one', 'Original command.', '/tab-a')
    expect(injected).toBe(true)
    await expect(competing).rejects.toThrow('Retry the previous pending message')
    expect(nextId).toBe(1)
    expect(first.readPendingOperatorMessage('conversation-one').command).toEqual(winner)
    expect(second.readPendingOperatorMessage('conversation-one').command).toEqual(winner)
  })

  it('recovers a lost HTTP response with the same ID and original context, not a second identity', async () => {
    const first = await tab()
    const submitted = await first.reserveOperatorMessage('conversation-one', 'Accepted but response lost.', '/original')
    // The API may have accepted this request. No acknowledgement reached this tab.
    const reloaded = await tab()
    const recovered = reloaded.readPendingOperatorMessage('conversation-one').command!
    expect(recovered).toEqual(submitted)
    expect(await reloaded.reserveOperatorMessage('conversation-one', recovered.content, '/new-route')).toEqual(submitted)
    reloaded.assertOperatorMessageReserved('conversation-one', recovered)
    expect(nextId).toBe(1)
    expect(Object.keys(JSON.parse(window.localStorage.getItem(key())!)).sort()).toEqual(['content', 'context', 'requestId'])
  })

  it('serializes acknowledgement and reservation so a late receipt cannot erase a newer request', async () => {
    const first = await tab(), second = await tab()
    const previous = await first.reserveOperatorMessage('conversation-one', 'First command.', '/a')
    await first.acknowledgeOperatorMessage('conversation-one', previous.requestId)
    const next = await second.reserveOperatorMessage('conversation-one', 'Second command.', '/b')
    expect(await first.acknowledgeOperatorMessage('conversation-one', previous.requestId)).toBe(false)
    expect(second.readPendingOperatorMessage('conversation-one').command).toEqual(next)
    expect(() => first.assertOperatorMessageReserved('conversation-one', previous)).toThrow('pending message changed')
    expect(nextId).toBe(2)
  })

  it('invalidates a queued reservation on enrollment rotation even before the storage event reaches this tab', async () => {
    const first = await tab(), hold = gate()
    const held = locks.request(lockName, {}, () => hold.promise)
    const queued = first.reserveOperatorMessage('conversation-one', 'Old identity command.', '/old')
    window.localStorage.setItem(epochKey, 'epoch-b')
    hold.resolve(); await held
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(nextId).toBe(0)
    expect(window.localStorage.getItem(key('epoch-a'))).toBeNull()
    expect(window.localStorage.getItem(key('epoch-b'))).toBeNull()
  })

  it('does not expose or retry an old enrollment request after epoch rotation', async () => {
    const first = await tab()
    const old = await first.reserveOperatorMessage('conversation-one', 'Old enrollment.', '/old')
    window.localStorage.setItem(epochKey, 'epoch-b')
    expect(first.readPendingOperatorMessage('conversation-one')).toEqual({})
    expect(() => first.assertOperatorMessageReserved('conversation-one', old)).toThrow()
    expect(nextId).toBe(1)
  })

  it('fails closed without Web Locks instead of silently using an unsafe storage lock', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const first = await tab()
    await expect(first.reserveOperatorMessage('conversation-one', 'Do not submit.', '/')).rejects.toThrow('Web Locks')
    expect(nextId).toBe(0)
    expect(window.localStorage.getItem(key())).toBeNull()
  })

  it('fails before submission when the durable write fails and does not discard an unreadable pending request', async () => {
    const first = await tab()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    await expect(first.reserveOperatorMessage('conversation-one', 'No durable ID.', '/')).rejects.toThrow('Quota exceeded')
    expect(window.localStorage.getItem(key())).toBeNull()
    vi.restoreAllMocks()
    window.localStorage.setItem(key(), '{unreadable')
    await expect(first.reserveOperatorMessage('conversation-one', 'Do not overwrite.', '/')).rejects.toThrow('storage')
    expect(window.localStorage.getItem(key())).toBe('{unreadable')
  })
})
