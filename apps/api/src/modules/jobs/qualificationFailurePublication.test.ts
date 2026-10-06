import { expect, it } from 'vitest'
import { publishFailedQualification } from './qualificationExecution.js'

it('publishes a failed qualification after closure and preserves its diagnostic failure', async () => {
  const calls: string[] = []
  await expect(publishFailedQualification({ suite: 'install', exitCode: 1, stderr: 'fixture install failure',
    closeContainer: async () => { calls.push('close'); return true },
    publish: async () => { calls.push('publish'); return { outcome: 'failed' } },
  })).rejects.toThrow('fixture install failure')
  expect(calls).toEqual(['close', 'publish'])
})

it('refuses publication when original descendants are not confirmed stopped', async () => {
  const calls: string[] = []
  await expect(publishFailedQualification({ suite: 'install', exitCode: 1, stderr: 'fixture install failure',
    closeContainer: async () => false,
    publish: async () => { calls.push('publish') },
  })).rejects.toThrow('descendants')
  expect(calls).toEqual([])
})
