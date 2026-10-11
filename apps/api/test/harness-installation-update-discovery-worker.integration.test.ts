import { describe, expect, it } from 'vitest'
import { installationUpdateFixture, profileReader, profiles, startWhenReady, pinnedPlacements, completedRun }
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('cancels Start during required Worker discovery without canceling its shared refresh or persisting a Run', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'worker' })
    try {
      const reader = await profileReader(fixture)
      await fixture.blockWorkerDiscovery()
      await expect(fixture.start()).rejects.toThrow('RUN_START_PREPARATION_TIMEOUT')
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      expect((await profiles(fixture, reader))[0]!.qualification).toBe('qualified')
      await fixture.releaseWorkerDiscovery()
      const started = (await startWhenReady(fixture))!
      expect(fixture.sourceManifest.git?.repository).toBe(fixture.repositoryName)
      expect(await pinnedPlacements(fixture, started.run.id)).toEqual([expect.objectContaining({
        hostRef: fixture.hostRef,
        source: expect.objectContaining({ manifestDigest: fixture.sourceManifest.manifestDigest }),
      })])
      await completedRun(fixture, started.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)
})
