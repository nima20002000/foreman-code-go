import { BugReportStatusSchema, type BugReport } from '@foreman-code/contracts/management'
import type { RefObject } from 'react'
import { isAccessFailure } from '../../shared/api/accessErrors'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { Alert, Badge, Button, Dialog, LoadingState, Select } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useBugReport } from './bugReportQueries'
import { severityLabels, statusLabels, statusOptions } from './bugReportPresentation'

function ReportContent({ report }: { report: BugReport }) {
  return <div className="bug-report-content">
    <div className="bug-report-badges">
      <Badge>{severityLabels[report.severity]} severity</Badge>
      <Badge>{statusLabels[report.status]}</Badge>
    </div>
    <section><h3>What they tried</h3><p><strong>{report.tried.feature}</strong></p>
      <p>{report.tried.inputsSummary}</p></section>
    <section><h3>What happened</h3>
      {report.happened.errorCode && <p><code>{report.happened.errorCode}</code></p>}
      <p>{report.happened.message}</p></section>
    <section><h3>Expected behavior</h3><p>{report.expected}</p></section>
    <dl className="bug-report-facts">
      <div><dt>Reporter</dt><dd>{report.reporter.name} ({report.reporter.audience})</dd></div>
      <div><dt>Workspace</dt><dd>{report.workspaceId}</dd></div>
      <div><dt>Harness</dt><dd>{report.harness ?? 'Not recorded'}</dd></div>
      <div><dt>First reported</dt><dd><time dateTime={report.createdAt}>
        {new Date(report.createdAt).toLocaleString()}</time></dd></div>
      <div><dt>Last reported</dt><dd><time dateTime={report.lastReportedAt}>
        {new Date(report.lastReportedAt).toLocaleString()}</time></dd></div>
      <div><dt>Occurrences</dt><dd>{report.occurrenceCount}</dd></div>
      {report.workflowId && <div><dt>Workflow</dt><dd>{report.workflowId}</dd></div>}
      {report.runId && <div><dt>Run</dt><dd>{report.runId}</dd></div>}
    </dl>
  </div>
}

export function BugReportDialog({ reportId, returnFocusRef, onClose }: {
  reportId: string
  returnFocusRef: RefObject<HTMLElement | null>
  onClose(): void
}) {
  const { report, update, denied, uncertain, refresh, retry } = useBugReport(reportId)
  const value = denied ? undefined : report.data
  const updateDenied = isAccessFailure(update.error)
  useUnsavedChanges({
    label: 'Bug report status',
    dirty: false,
    busy: update.isPending,
    uncertain,
    saveDisabled: denied || updateDenied,
    error: update.isError ? update.error.message : undefined,
    save: retry,
    discard() {},
  })
  const locked = update.isPending || uncertain
  return <Dialog open title={value?.title ?? 'Bug report'} size="lg" busy={update.isPending}
    returnFocusRef={returnFocusRef}
    dismissible={!uncertain} onOpenChange={open => { if (!open && !locked) onClose() }}
    footer={<Button disabled={locked} onClick={onClose}>Close report</Button>}>
    {report.isPending && <LoadingState label="Reading bug report…" />}
    {report.isError && <Alert live tone="danger" title={report.error.message}
      action={<Button disabled={update.isPending} onClick={() => void refresh()}>Refresh report</Button>} />}
    {value && <>
      <ReportContent report={value} />
      <Select label="Report status" hint="Status changes save immediately."
        value={value.status} options={statusOptions}
        disabled={report.isError || update.isPending || update.isError || sessionIsSwitching()}
        onChange={event => update.mutate({
          commandId: crypto.randomUUID(),
          reportId,
          expectedRevision: value.revision,
          status: BugReportStatusSchema.parse(event.target.value),
        })} />
    </>}
    {update.isPending && <p role="status">Saving status…</p>}
    {update.isSuccess && !report.isError && <p role="status">Status saved.</p>}
    {update.isError && <Alert live tone="danger" title={update.error.message}>
      {updateDenied && <p>Your access does not allow status changes.</p>}
      {uncertain ? <>
        <p>The save is unconfirmed. Retry the same change before leaving.</p>
        <Button disabled={denied || updateDenied} onClick={() => update.variables && update.mutate(update.variables)}>
          Retry status save
        </Button>
      </> : <Button disabled={report.isFetching} onClick={() => void refresh()}>Refresh report</Button>}
    </Alert>}
  </Dialog>
}
