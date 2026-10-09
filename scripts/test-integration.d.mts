import type { VerificationCapability, VerificationEnvironment }
  from '../packages/contracts/src/verificationEnvironment.mjs'

interface TestCounts {
  total: number
  passed: number
  failed: number
  skipped: number
}

interface IntegrationFileResult {
  file: string
  code: number | null
  complete: boolean
  requiredCapabilities?: VerificationCapability[]
  reason?: string
  report?: { totals: TestCounts }
}

export function integrationReport(
  selected: string[],
  firstPass: IntegrationFileResult[],
  retests: IntegrationFileResult[],
  options: {
    startedAt: string
    finishedAt: string
    interrupted?: string
    diagnostic: boolean
    processStopped: boolean
    environment?: VerificationEnvironment
  },
): {
  schemaVersion: 1
  suite: 'integration'
  startedAt: string
  finishedAt: string
  environment: VerificationEnvironment | undefined
  outcome: 'passed' | 'failed' | 'incomplete' | 'cancelled'
  completeness: 'complete' | 'partial'
  expectedPortions: number
  completedPortions: number
  firstPassFailed: number
  disallowedSkipped: number
  totals: TestCounts
  files: Array<Omit<IntegrationFileResult, 'report'> & { totals?: TestCounts }>
  retests: Array<Omit<IntegrationFileResult, 'report'> & { totals: TestCounts }>
}
