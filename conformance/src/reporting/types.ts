export const LANES = ['SKEL', 'E', 'H', 'J', 'A1', 'S', 'R', 'A2'] as const

export type Lane = typeof LANES[number]
export type Target = 'ts' | 'go'

export interface ScenarioFailure {
  name: string
  message: string
  details?: unknown
  causes?: ScenarioFailure[]
  cause?: ScenarioFailure
}

export interface ScenarioOutcome {
  id: string
  title: string
  lane: Lane
  status: 'passed' | 'failed'
  phase: 'setup' | 'scenario' | 'cleanup'
  executed: boolean
  durationMs: number
  error?: ScenarioFailure
}

export interface ResultTotals {
  total: number
  passed: number
  failed: number
  skipped: 0
}

export interface RunIdentity {
  repository: 'nima20002000/foreman-code-go'
  baselineSha: string
  commitSha: string
  commitSource: 'environment' | 'git'
}

export interface RunReport extends RunIdentity {
  schemaVersion: 1
  target: Target
  status: 'passed' | 'failed'
  startedAt: string
  finishedAt: string
  durationMs: number
  totals: ResultTotals
  lanes: Record<Lane, ResultTotals>
  scenarios: ScenarioOutcome[]
  setupError?: ScenarioFailure
  cleanupError?: ScenarioFailure
}
