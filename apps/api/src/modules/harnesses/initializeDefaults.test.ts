import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { initializeNativeDefaults } from './initializeDefaults.js'
import { UNAVAILABLE_HARNESS_DEFAULTS_KEY } from '../settings/postgres.js'

afterEach(() => { vi.useRealTimers() })

function startupDefaultsFixture() {
  const rows = [
    { key: 'harness-defaults', record: DEFAULT_HARNESS_DEFAULTS, revision: '4' },
    { key: 'agent-defaults-v1', record: DEFAULT_AGENT_DEFAULTS, revision: '2' },
    { key: UNAVAILABLE_HARNESS_DEFAULTS_KEY, record: [], revision: '1' },
  ]
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows }),
    release: vi.fn(),
  }
  const query = vi.fn().mockResolvedValue({ rows })
  const connect = vi.fn().mockResolvedValue(client)
  const options = vi.fn().mockRejectedValue(new Error('No installed Claude profile'))
  return {
    client,
    query,
    connect,
    options,
    input: {
      pool: { query, connect } as never,
      options,
      appMcpEndpoint: 'http://127.0.0.1:3000/mcp',
    },
  }
}

it('retries the initial settings read before discovering native defaults', async () => {
  vi.useFakeTimers()
  const fixture = startupDefaultsFixture()
  fixture.query.mockRejectedValueOnce(new Error('Query read timeout'))
  const initialized = initializeNativeDefaults(fixture.input).catch(error => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await initialized).toEqual(DEFAULT_HARNESS_DEFAULTS)
  expect(fixture.query).toHaveBeenCalledTimes(2)
  expect(fixture.options).toHaveBeenCalledOnce()
  expect(fixture.connect).toHaveBeenCalledOnce()
  expect(fixture.client.release).toHaveBeenCalledOnce()
})

it('retries acquiring the settings transaction without repeating native discovery', async () => {
  vi.useFakeTimers()
  const fixture = startupDefaultsFixture()
  fixture.connect.mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
  const initialized = initializeNativeDefaults(fixture.input).catch(error => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await initialized).toEqual(DEFAULT_HARNESS_DEFAULTS)
  expect(fixture.query).toHaveBeenCalledOnce()
  expect(fixture.options).toHaveBeenCalledOnce()
  expect(fixture.connect).toHaveBeenCalledTimes(2)
  expect(fixture.client.release).toHaveBeenCalledOnce()
})

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
