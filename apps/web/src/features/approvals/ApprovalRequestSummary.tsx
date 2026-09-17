import type { DurableInteraction } from '@graphql/contracts'
import { summarizeApprovalRequest } from './approvalPresentation'
import './approvalSummary.css'

export function ApprovalRequestSummary({ request, nativeRequestType }: {
  request: DurableInteraction['request']
  nativeRequestType?: string
}) {
  const summary = summarizeApprovalRequest(request, nativeRequestType)
  return <div className="approval-request-summary">
    <h3>{summary.operation}</h3>
    {summary.command ? <p><strong>Command:</strong> <code>{summary.command}</code></p> : null}
    <p><strong>Target:</strong> {summary.target ?? 'Not supplied by the provider. Review technical details before deciding.'}</p>
    {summary.explanation ? <p><strong>Provider explanation:</strong> {summary.explanation}</p> : null}
    <p>Approval permits an attempt within the existing sandbox; it does not make the operation safe. Check the scope of the response below, especially choices affecting other requests or persistent policy.</p>
  </div>
}
