import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: undefined as ReturnType<typeof Fastify> | undefined,
  calls: [] as string[],
  finishRecovery: undefined as (() => void) | undefined,
  listeners: new Map<string, () => void>(),
}))
vi.mock('@foreman-code/contracts/product-environment-node', () => ({ loadProductEnvFile: () => undefined }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdir: async () => undefined,
  realpath: async (path: string) => path,
}))
// Native qualification belongs to buildProductionApp, which this lifecycle fixture replaces.
vi.mock('../src/modules/harnesses/qualification/suites/codex.js', () => ({ codexQualificationSuite: {} }))
vi.mock('../src/infrastructure/logger.js', async original => ({
  ...(await original<typeof import('../src/infrastructure/logger.js')>()),
  enableFileLogging: async () => undefined,
}))
vi.mock('../src/config.js', () => ({ loadConfig: () => ({ database: {}, checkpoints: { schema: 'test' }, harnesses: { workspaceRoot: process.env.HARNESS_WORKSPACE_ROOT }, host: '127.0.0.1', port: 0 }) }))
vi.mock('../src/modules/byte-transfer/installedEntrypoints.js', () => ({ readMainRsyncEntrypoint: async () => ({ kind: 'unavailable', reason: 'Startup lifecycle fixture has no installed rsync selection.' }) }))
vi.mock('../src/infrastructure/database.js', () => ({ createDatabase: () => ({
  pool: {}, ping: async () => undefined, migrate: async () => undefined,
  close: async () => { state.calls.push('database closed') },
}) }))
vi.mock('../src/infrastructure/checkpoints.js', () => ({ createCheckpointStore: () => ({
  setup: async () => undefined, ping: async () => undefined,
  close: async () => { state.calls.push('checkpoints closed') },
}) }))
vi.mock('../src/production.js', () => ({ buildProductionApp: () => ({
  app: state.app,
  rsync: { kind: 'unavailable' },
  registerFileStorage: () => { expect(state.listeners.has('SIGTERM')).toBe(true) },
  startDeviceListener: async () => undefined,
  initialize: async () => undefined,
  reconcile: async () => {
    state.calls.push('recovery started')
    await new Promise<void>((resolve) => { state.finishRecovery = resolve })
  },
  drainShutdown: async () => { state.calls.push('native shutdown'); state.finishRecovery?.() },
}) }))

it('handles SIGTERM while startup recovery is still running and closes all resources', async () => {
  state.app = Fastify()
  const once = vi.spyOn(process, 'once').mockImplementation(function (this: NodeJS.Process, event: string | symbol, listener: (...args: unknown[]) => void) {
    if (event === 'SIGTERM' || event === 'SIGINT') state.listeners.set(event, listener)
    return this
  })
  vi.spyOn(state.app, 'listen').mockImplementation(async () => {
    expect(state.listeners.has('SIGTERM')).toBe(true)
    await state.app!.ready()
    state.calls.push('listening')
    return 'http://localhost:0'
  })
  try {
    await import('../src/server.js')
    await vi.waitFor(() => expect(state.calls).toContain('recovery started'))
    state.listeners.get('SIGTERM')!()
    await vi.waitFor(() => expect(state.calls).toContain('database closed'))
    await delay(5)
    expect(state.calls).toEqual(['listening', 'recovery started', 'native shutdown', 'checkpoints closed', 'database closed'])
  } finally {
    state.finishRecovery?.()
    await state.app.close()
    once.mockRestore()
    vi.restoreAllMocks()
  }
})
