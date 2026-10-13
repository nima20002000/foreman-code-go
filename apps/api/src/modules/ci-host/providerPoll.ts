import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostCiPorts } from './runner.js'

type ReadCache = WeakMap<HostCiPorts, Map<string, Promise<string>>>
const polls = new AsyncLocalStorage<ReadCache>()
const inFlight: ReadCache = new WeakMap()

/** A dispatcher pass and its nested ticket follows share a single provider snapshot. */
export function withProviderPoll<T>(operation: () => Promise<T>): Promise<T> {
  if (polls.getStore()) return operation()
  return polls.run(new WeakMap(), operation)
}

function cacheFor(caches: ReadCache, ports: HostCiPorts) {
  let cache = caches.get(ports)
  if (!cache) {
    cache = new Map()
    caches.set(ports, cache)
  }
  return cache
}

/** Only provider listings are shared; mutations invalidate the snapshot before they run. */
export async function providerCommand(ports: HostCiPorts, file: string, args: string[], execute: () => Promise<string>) {
  const poll = polls.getStore()
  const cache = poll ? cacheFor(poll, ports) : undefined
  const pending = cacheFor(inFlight, ports)
  const isRead = file === 'gh' && args[0] === 'run' && args[1] === 'list'
    || file === 'circleci' && args[1] === 'get' && (args[0] === 'run' || args[0] === 'job')
  if (!isRead) {
    const isMutation = file === 'gh' && args[0] === 'workflow' && args[1] === 'run'
      || args[0] === 'run' && (args[1] === 'trigger' || args[1] === 'cancel')
    if (isMutation) {
      cache?.clear()
      pending.clear()
    }
    return execute()
  }
  const key = JSON.stringify([file, args])
  const existing = cache?.get(key) ?? pending.get(key)
  if (existing) {
    cache?.set(key, existing)
    return existing
  }
  const result = execute()
  cache?.set(key, result)
  pending.set(key, result)
  try {
    return await result
  } catch (error) {
    if (cache?.get(key) === result) cache.delete(key)
    throw error
  } finally {
    if (pending.get(key) === result) pending.delete(key)
  }
}
