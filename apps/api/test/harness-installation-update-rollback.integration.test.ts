import { describe, expect, it } from 'vitest'
import { placementDigest } from '../src/modules/placement/binding.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import {
  installationUpdateFixture, profileReader, profiles, runningTurn,
  pinnedPlacements, latestEvidence, startWhenReady, completedRun,
}
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('keeps a Worker Run on its original profile proof through a payload update and rollback', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'worker' })
    let blocked = false
    try {
      const reader = await profileReader(fixture)
      const original = (await profiles(fixture, reader))[0]!
      await fixture.provider.blockWorkflowTurns()
      blocked = true
      const started = await fixture.start()
      const turn = await runningTurn(fixture)
      const pins = await pinnedPlacements(fixture, started.run.id)
      await fixture.provider.updatePayload()
      await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
        value.qualification === 'qualified' && value.revision === original.revision + 1), 'qualified intermediate payload')
      await fixture.provider.restorePayload()
      await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
        value.qualification === 'qualified' && value.revision === original.revision + 2
          && value.target.installationFingerprint === original.target.installationFingerprint), 'qualified rollback')
      const latest = (await latestEvidence(fixture))[0]!
      const next = (await startWhenReady(fixture))!
      const newPins = await pinnedPlacements(fixture, next.run.id)
      expect(newPins[0]!.payload).toMatchObject({ profileProofDigest: placementDigest(latest) })
      expect(newPins[0]!.payload).not.toEqual(pins[0]!.payload)
      expect(process.kill(turn.pid, 0)).toBe(true)
      await fixture.provider.releaseWorkflowTurns()
      blocked = false
      await completedRun(fixture, started.run.id)
      await completedRun(fixture, next.run.id)
      expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
      expect(await fixture.provider.calls()).toContainEqual({ workflowCompleted: turn })
    } finally {
      if (blocked) await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 240_000)
})
