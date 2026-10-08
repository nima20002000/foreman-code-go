import { expect, it, vi } from 'vitest'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { RunOwnership } from '../runs/ownership.js'
import { ExecutionScopedNativeSessionManagerResolver } from './runtimePorts.js'

const context = {
  harness: 'codex' as const,
  executionId: 'execution',
  agentId: 'agent',
  runId: 'run',
  workingDirectory: '/project',
  configuration: { id: 'configuration' } as AgentConfigurationVersion,
}

it('retains the original Run owner during disposal and retries a failed receipt commit', async () => {
  const owner = { runId: 'run', assertOwned: vi.fn() } as unknown as RunOwnership
  let getOwner!: () => RunOwnership | undefined
  let confirmClosure = false
  const dispose = vi.fn(async () => {
    expect(getOwner()).toBe(owner)
    getOwner()!.assertOwned()
    if (!confirmClosure) throw new Error('Closure receipt commit failed')
  })
  const resolver = new ExecutionScopedNativeSessionManagerResolver((_context, getter) => {
    getOwner = getter
    return { harness: 'codex', dispose } as unknown as NativeHarnessSessionManager
  })
  const resolved = resolver.resolve(context, owner)
  resolved.beginStart?.()
  resolved.markResident?.()

  await expect(resolver.dispose()).rejects.toThrow('disposal was incomplete')
  expect(getOwner()).toBeUndefined()
  expect(resolved.lifecycle).toBe('failed')
  expect(() => resolver.resolve(context, owner)).toThrow('shutting down')
  expect(() => resolved.beginStart?.()).toThrow('already starting')
  expect(() => resolved.markResident?.()).toThrow('cannot become resident')

  confirmClosure = true
  await resolver.dispose()
  expect(dispose).toHaveBeenCalledTimes(2)
  expect(resolved.lifecycle).toBe('released')
  expect(getOwner()).toBeUndefined()
})

it('keeps disposal failed when the original Run owner loses authority', async () => {
  const owner = { runId: 'run', assertOwned: vi.fn() } as unknown as RunOwnership
  const dispose = vi.fn()
  const resolver = new ExecutionScopedNativeSessionManagerResolver((_context, getOwner) => {
    dispose.mockImplementation(async () => {
      const current = getOwner()
      expect(current).toBe(owner)
      current!.assertOwned()
    })
    return { harness: 'codex', dispose } as unknown as NativeHarnessSessionManager
  })
  const resolved = resolver.resolve(context, owner)
  vi.mocked(owner.assertOwned).mockImplementation(() => { throw new Error('Run ownership lost') })

  await expect(resolver.dispose()).rejects.toThrow('disposal was incomplete')
  expect(resolved.lifecycle).toBe('failed')
  vi.mocked(owner.assertOwned).mockReset()
  await resolver.dispose()
  expect(resolved.lifecycle).toBe('released')
})
