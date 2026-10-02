import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { buildProductionApp } from '../src/production.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'

it('constructs the activity replay through production without installed inventory discovery', async () => {
  const replay = new ActivityProductionReplay()
  const infrastructure = replay.infrastructure()
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/replay',
    CODEX_BINARY: '/recorded-no-native-codex', OPENCODE_BINARY: '/recorded-no-native-opencode' })
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(config.database.connectionString, 'replay', config.database)
  try {
    const production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, infrastructure)
    try {
      const environment = { generation: 'recorded-environment', provenance: 'terminal' as const, cwd: '/recorded', path: '' }
      for (const requested of [config.harnesses.codexBinary, config.harnesses.openCodeBinary]) {
        expect(await infrastructure.inventoryDiscovery!.launcher(requested, environment)).toMatchObject({
          requested, environment, status: 'missing', resolvedLauncher: null, fingerprint: null,
        })
      }
      await expect(infrastructure.inventoryDiscovery!.payloads('codex', config.harnesses.codexBinary)).rejects.toThrow('Unrecorded auxiliary replay operation.')
      expect(replay.starts).toEqual([])
      expect(replay.calls).toEqual([])
    } finally { await production.app.close() }
    const incomplete = { ...infrastructure }
    delete incomplete.inventoryDiscovery
    expect(() => buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, incomplete))
      .toThrow('Replay must inject settings and probes and cannot run installed CLI qualification.')
  } finally { await Promise.all([database.close(), checkpoints.close()]) }
})
