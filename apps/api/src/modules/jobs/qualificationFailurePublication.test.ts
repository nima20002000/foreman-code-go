import { expect, it } from 'vitest'
import { JobVerificationReportSchema } from '@foreman-code/contracts/job-verification'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { publishFailedQualification } from './qualificationExecution.js'

function failedReport() {
  const { spec } = verificationRuntimeFixture()
  const now = new Date().toISOString()
  return JobVerificationReportSchema.parse({ schemaVersion: 1,
    commit: spec.source.commit, manifestDigest: spec.source.manifestDigest,
    definitionVersionId: spec.definitionVersionId, suite: 'unit', executionId: 'qualification:unit',
    attemptId: 'qualification:unit', target: spec.target, profile: spec.profile,
    resources: spec.verification.resources, parameters: spec.verification.parameters,
    startedAt: now, finishedAt: now, totals: { total: 5, passed: 1, failed: 4, skipped: 0 },
    firstPassFailed: 4, expectedPortions: 3, completedPortions: 2,
    disallowedSkipped: 0, completeness: 'partial', outcome: 'failed',
  })
}

it('publishes a failed qualification after closure and preserves its diagnostic failure', async () => {
  const calls: string[] = []
  await expect(publishFailedQualification({ suite: 'install', exitCode: 1, stderr: 'fixture install failure',
    closeContainer: async () => { calls.push('close'); return true },
    publish: async () => { calls.push('publish'); return failedReport() },
  })).rejects.toThrow('fixture install failure')
  expect(calls).toEqual(['close', 'publish'])
})

it('refuses publication when original descendants are not confirmed stopped', async () => {
  const calls: string[] = []
  await expect(publishFailedQualification({ suite: 'install', exitCode: 1, stderr: 'fixture install failure',
    closeContainer: async () => false,
    publish: async () => { calls.push('publish'); return failedReport() },
  })).rejects.toThrow('descendants')
  expect(calls).toEqual([])
})

it('identifies retained reports and measured failures when the command emits no stderr', async () => {
  await expect(publishFailedQualification({ suite: 'unit', exitCode: 7, stderr: ' \n ',
    closeContainer: async () => true,
    publish: async () => failedReport(),
  })).rejects.toThrow('unit qualification failed (exit 7). Reports: Job qualification:unit. '
    + '4 failed checks; 2/3 portions complete (failed).')
})

it('preserves the execution failure when report publication also fails', async () => {
  await expect(publishFailedQualification({ suite: 'unit', exitCode: 7, stderr: 'worker tests failed',
    closeContainer: async () => true,
    publish: async () => { throw new Error('artifact storage unavailable') },
  })).rejects.toThrow('unit qualification failed (exit 7). Report publication failed: artifact storage unavailable. '
    + 'worker tests failed')
})

it('keeps the report reference in a bounded reason when stderr is large', async () => {
  const reason = await publishFailedQualification({ suite: 'unit', exitCode: 1, stderr: 'x'.repeat(2000),
    closeContainer: async () => true,
    publish: async () => failedReport(),
  }).catch((error: Error) => error.message)
  expect(reason).toContain('Reports: Job qualification:unit.')
  expect(reason.length).toBeLessThanOrEqual(500)
})
