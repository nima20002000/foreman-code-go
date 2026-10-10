import type { BugReportSeverity, BugReportStatus } from '@foreman-code/contracts/management'

export const statusLabels: Record<BugReportStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  fixed: 'Fixed',
  'wont-fix': "Won’t fix",
}
export const severityLabels: Record<BugReportSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}
export const statusOptions = Object.entries(statusLabels).map(([value, label]) => ({ value, label }))
export const severityOptions = Object.entries(severityLabels).map(([value, label]) => ({ value, label }))
