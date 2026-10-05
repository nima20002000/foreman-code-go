import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { NativeProcessRegistry } from '../recovery/processRegistry.js'
import { ownedClaudeSdkQueries } from './official.js'
import type { ClaudeSdkClient } from './port.js'
import { createClaudeSdkRunner } from './runner.js'

it('persists no-start closure when SDK dispatch throws before native spawn, including fresh-registry recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-query-start-'))
  const registry = new NativeProcessRegistry(root)
  let deferredSpawn: Options['spawnClaudeCodeProcess']
  const sdkQuery = vi.fn(({ options }: { options?: Options }) => {
    deferredSpawn = options?.spawnClaudeCodeProcess
    throw new Error('SDK query failed before spawn')
  })
  const owned = ownedClaudeSdkQueries({ sdk: { query: sdkQuery }, recovery: registry.scope('query-owner'),
    binary: '/unused-claude' })
  const client: ClaudeSdkClient = { sdkVersion: '0.3.284', ...owned,
    getSessionInfo: async sessionId => ({ sessionId }), getSessionMessages: async () => [],
    forkSession: async () => ({ sessionId: 'unused' }) }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  try {
    expect(await registry.closeOwner('query-owner')).toBe(false)
    await expect(runner.open({ scope: { deviceId: 'test', profilePath: root, cwd: root, configRevision: '1' },
      options: {} })).rejects.toThrow('SDK query failed before spawn')
    expect(sdkQuery).toHaveBeenCalledTimes(1)
    expect(runner.requiresRuntimeClosure!()).toBe(false)
    expect(await new NativeProcessRegistry(root).closeOwner('query-owner')).toBe(true)
    expect(() => deferredSpawn!({ command: '/unused-claude', args: [], cwd: root,
      env: {}, signal: new AbortController().signal })).toThrow('closed before native launch')
  } finally {
    await runner.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
