import { describe, expect, it } from 'vitest'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import {
  installationUpdateFixture, profileReader, profiles, runningTurn, pinnedPlacements, startWhenReady, completedRun,
}
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it.each(['worker'] as const)(
    'retains a resident %s Run across unavailable inventory before a completed payload replacement',
    async executionHost => {
      const fixture = await installationUpdateFixture({ workflow: 'single', executionHost })
      let blocked = false
      try {
        const reader = await profileReader(fixture)
        const before = (await profiles(fixture, reader))[0]!
        await fixture.provider.blockWorkflowTurns()
        blocked = true
        const started = await fixture.start()
        const turn = await runningTurn(fixture)
        const pins = await pinnedPlacements(fixture, started.run.id)
        await fixture.provider.removePayload()
        const unavailable = await waitForRemoteReview(() => fixture.inventory(), value => value.installations.some(installation =>
          installation.driverId === 'codex' && !installation.installed && installation.installationFingerprint === null),
        'unavailable intermediate inventory')
        expect(unavailable.installations.find(installation => installation.driverId === 'codex')).toMatchObject({
          harnessInstallationId: before.target.harnessInstallationId,
          installed: false,
          installationFingerprint: null,
        })
        await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
          value.qualification === 'unqualified' && value.qualificationFailure !== undefined), 'unavailable profile readback')
        await expect(fixture.start()).rejects.toThrow('HARNESS_INSTALLATION_INVALID')
        expect(process.kill(turn.pid, 0)).toBe(true)
        await fixture.provider.updatePayload()
        await waitForRemoteReview(() => profiles(fixture, reader), values => values.every(value =>
          value.qualification === 'qualified' && value.target.installationFingerprint !== before.target.installationFingerprint),
        'qualified replacement after missing inventory')
        const next = (await startWhenReady(fixture))!
        await fixture.provider.releaseWorkflowTurns()
        blocked = false
        await completedRun(fixture, started.run.id)
        await completedRun(fixture, next.run.id)
        expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
        expect(await fixture.provider.calls()).toContainEqual({ workflowCompleted: turn })
        expect((await pinnedPlacements(fixture, next.run.id))[0]!.payload).toMatchObject({
          installationFingerprint: (await profiles(fixture, reader))[0]!.target.installationFingerprint,
        })
      } finally {
        if (blocked) await fixture.provider.releaseWorkflowTurns()
        await fixture.close()
      }
    }, 240_000)
})
