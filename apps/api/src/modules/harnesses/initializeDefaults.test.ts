import { expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { initializeNativeDefaults } from './initializeDefaults.js'
import { UNAVAILABLE_HARNESS_DEFAULTS_KEY } from '../settings/postgres.js'

it('initializes supported defaults when saved settings retain retired configuration and availability facts', async () => {
  const savedHarnesses = {
    ...DEFAULT_HARNESS_DEFAULTS,
    opencode: { harness: 'opencode', model: 'saved-model', variant: 'high',
      nativeAgent: 'plan', thinking: true, autoApprove: false },
  }
  const original = structuredClone(savedHarnesses)
  const rows = [
    { key: 'harness-defaults', record: savedHarnesses, revision: '4' },
    { key: 'agent-defaults-v1', record: DEFAULT_AGENT_DEFAULTS, revision: '2' },
    { key: UNAVAILABLE_HARNESS_DEFAULTS_KEY, record: ['opencode'], revision: '1' },
  ]
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows }),
    release: vi.fn(),
  }
  const options = vi.fn().mockRejectedValue(new Error('No installed Claude profile'))
  const defaults = await initializeNativeDefaults({
    pool: { query: async () => ({ rows }), connect: async () => client } as never,
    options,
    appMcpEndpoint: 'http://127.0.0.1:3000/mcp',
  })
  expect(defaults).toEqual(DEFAULT_HARNESS_DEFAULTS)
  expect(savedHarnesses).toEqual(original)
  expect(options).toHaveBeenCalledTimes(1)
  expect(options).toHaveBeenCalledWith('claude')
  expect(client.release).toHaveBeenCalledOnce()
})
