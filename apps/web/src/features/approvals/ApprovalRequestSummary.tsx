import type { DurableInteraction } from '@graphql/contracts'
import { Alert, Surface } from '../../shared/ui/nocturne'
import { summarizeApprovalRequest } from './approvalPresentation'
import './approvalSummary.css'

export function ApprovalRequestSummary({ request, nativeRequestType, reviewContext }: {
  request: DurableInteraction['request']
  nativeRequestType?: string
  reviewContext?: DurableInteraction['reviewContext']
}) {
  const summary = summarizeApprovalRequest(request, nativeRequestType)
  return <Surface className="approval-request-summary">
    <h3>{summary.operation}</h3>
    {summary.command ? <p><strong>Command:</strong> <code>{summary.command}</code></p> : null}
    <p><strong>Target:</strong> {reviewContext?.target ?? summary.target ?? 'Not supplied by the provider. Review technical details before deciding.'}</p>
    {reviewContext ? <p><strong>Proposed change:</strong> {reviewContext.changeSummary}</p> : null}
    {summary.explanation ? <p><strong>Provider explanation:</strong> {summary.explanation}</p> : null}
    <Alert tone="warning" title="Review the response scope">Approval permits an attempt within the existing sandbox; it does not make the operation safe. Check choices affecting other requests or persistent policy.</Alert>
  </Surface>
}
