export interface AffectedSelection {
  scope: 'affected' | 'full'
  files: string[]
  reason: string
}

export function affectedSnapshot(commit: string, suite: string, cwd?: string, defaultRef?: string, baseCommit?: string): AffectedSelection

export function selectAffectedFiles(input: {
  suite: string
  changedFiles: string[]
  sources: Map<string, string>
  exports?: Record<string, unknown>
}): AffectedSelection
