import { describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import type { NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'

const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] }

describe('native MCP settings reads', () => {
  it.each(['codex', 'opencode'] as const)('shares simultaneous %s reads instead of starting competing native processes', async (harness) => {
    const snapshot: NativeMcpSnapshot = { harness, revision: 'revision', effective: {}, user: {},
      userConfig: {}, file: '/tmp/native-user-config', version: 'version' }
    let finish!: (value: NativeMcpSnapshot) => void
    const read = vi.fn(() => new Promise<NativeMcpSnapshot>((resolve) => { finish = resolve }))
    const adapter = { read, apply: vi.fn() }
    const service = new HarnessMcpSettingsService({} as never, {} as never,
      { codex: adapter, opencode: adapter }, () => undefined)

    const first = service.list(principal, harness)
    const second = service.list(principal, harness)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    finish(snapshot)
    const [one, two] = await Promise.all([first, second])
    expect(one).toEqual(two)
    expect(one.servers).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
    await service.shutdown()
  })

  it('allows a fresh read after a failed check', async () => {
    const snapshot: NativeMcpSnapshot = { harness: 'codex', revision: 'revision', effective: {}, user: {},
      userConfig: {}, file: '/tmp/native-user-config', version: 'version' }
    const read = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(snapshot)
    const adapter = { read, apply: vi.fn() }
    const service = new HarnessMcpSettingsService({} as never, {} as never,
      { codex: adapter, opencode: adapter }, () => undefined)
    await expect(service.list(principal, 'codex')).rejects.toThrow('The native check could not complete')
    await expect(service.list(principal, 'codex')).resolves.toMatchObject({ harness: 'codex', servers: [] })
    expect(read).toHaveBeenCalledTimes(2)
    await service.shutdown()
  })
})
