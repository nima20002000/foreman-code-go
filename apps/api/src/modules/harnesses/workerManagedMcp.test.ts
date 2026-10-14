import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { WorkerManagedMcp } from './workerManagedMcp.js'
import { deviceManagedMcpFixture } from '../../../test/helpers/deviceManagedMcp.js'

it('installs and repairs managed MCP before a paired device becomes an Agent host', async () => {
  const f = await deviceManagedMcpFixture()
  const installLauncher = vi.fn(async () => {})
  const open = () => new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher })
  try {
    const worker = open()
    await worker.ensureReady(['codex', 'claude'])
    for (const harness of ['codex', 'claude'] as const) {
      const list = await worker.list(harness, AbortSignal.timeout(5000))
      expect(list.presets?.graphql).toBe('installed')
      expect(list.servers.map(server => server.name)).toEqual(expect.arrayContaining(['example', 'foreman-code']))
    }
    expect(f.writes()).toBe(2)
    await open().ensureReady(['codex', 'claude'])
    expect(f.writes()).toBe(2)
    const signal = AbortSignal.timeout(5000)
    await f.adapters.codex.apply(await f.adapters.codex.read(signal), { kind: 'remove', name: 'foreman-code' }, signal)
    await open().ensureReady(['codex', 'claude'])
    expect((await open().list('codex', signal)).presets?.graphql).toBe('installed')
    expect(f.writes()).toBe(4)
    expect(installLauncher).toHaveBeenCalled()
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

it('retains disabled policies and never replays an uncertain device write', async () => {
  const f = await deviceManagedMcpFixture()
  const signal = AbortSignal.timeout(5000)
  const input = { harness: 'codex' as const, preset: 'graphql' as const, installed: true, commandId: 'managed-install' }
  const open = () => new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
  try {
    const plan = await open().apply(input, 'operator', signal)
    expect(await open().apply(input, 'operator', signal)).toEqual(plan)
    expect(f.writes()).toBe(1)
    await open().apply({ harness: 'codex', preset: 'graphql', enabled: false, commandId: 'managed-disable' }, 'operator', signal)
    await open().ensureReady(['codex'])
    expect((await open().list('codex', signal)).presets?.graphql).toBe('disabled')
    const failing = new WorkerManagedMcp({ directory: f.directory, installLauncher: async () => {},
      adapters: { ...f.adapters, claude: { ...f.adapters.claude, apply: async () => { throw new Error('Lost reply') } } } })
    const uncertain = await failing.apply({ ...input, harness: 'claude' }, 'operator', signal)
    expect(uncertain.status).toBe('uncertain')
    expect(await open().apply({ ...input, harness: 'claude' }, 'operator', signal)).toEqual(uncertain)
    expect((await open().list('claude', signal)).presets?.graphql).toBe('missing')
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})
