import { describe, expect, it, vi } from 'vitest'
import type { AgentConfigurationVersion } from '@graphql/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const context = {
  harness: 'codex' as const, executionId: 'execution-1', agentId: 'agent-1', workingDirectory: '/fixture',
  configuration: { id: 'config-1', prompt: { text: 'pinned' } } as unknown as AgentConfigurationVersion,
}

describe('execution allocation cleanup ownership', () => {
  it('joins concurrent disposal, retains a failed allocation, and retries only remaining owners', async () => {
    const closing = gate()
    const first = { harness: 'codex', dispose: vi.fn(async () => { await closing.promise; throw new Error('cgroup not empty') }) }
    const second = { harness: 'codex', dispose: vi.fn(async () => undefined) }
    const factory = vi.fn((input) => input.executionId === 'execution-1' ? first : second)
    const resolver = new ExecutionScopedNativeSessionManagerResolver(factory as never)
    const failed = resolver.resolve(context)
    resolver.resolve({ ...context, executionId: 'execution-2' })
    const attempt = resolver.dispose()
    expect(resolver.dispose()).toBe(attempt)
    expect(() => resolver.resolve(context)).toThrow('shutting down')
    closing.resolve()
    await expect(attempt).rejects.toThrow('disposal was incomplete')
    expect(failed.lifecycle).toBe('failed')
    first.dispose.mockResolvedValueOnce(undefined)
    await resolver.dispose()
    expect(first.dispose).toHaveBeenCalledTimes(2)
    expect(second.dispose).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('does not release a successor or make an obsolete allocation resident', () => {
    const resolver = new ExecutionScopedNativeSessionManagerResolver(() => ({ harness: 'codex' } as NativeHarnessSessionManager))
    const original = resolver.resolve(context)
    resolver.release(context, original.manager)
    const next = resolver.resolve(context)
    resolver.release(context, original.manager)
    original.markFailed?.()
    expect(() => original.beginStart?.()).toThrow('already starting')
    expect(() => original.markResident?.()).toThrow('cannot become resident')
    expect(resolver.resolve(context).manager).toBe(next.manager)
    expect(next.lifecycle).toBe('allocated')
  })

  it('pins configuration independently of caller mutation without starting a session', () => {
    const createSession = vi.fn()
    const resolver = new ExecutionScopedNativeSessionManagerResolver(() => ({ harness: 'codex', createSession } as unknown as NativeHarnessSessionManager))
    const mutable = structuredClone(context)
    resolver.resolve(mutable)
    mutable.configuration.prompt = { text: 'changed' }
    expect(() => resolver.resolve(mutable)).toThrow('cannot change')
    expect(createSession).not.toHaveBeenCalled()
  })
})
