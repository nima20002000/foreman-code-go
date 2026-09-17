import type { DurableInteraction } from '@graphql/contracts'
import { Alert, Surface } from '../../shared/ui/nocturne'
import { summarizeApprovalRequest } from './approvalPresentation'
import './approvalSummary.css'

export function ApprovalRequestSummary({ request, nativeRequestType }: {
  request: DurableInteraction['request']
  nativeRequestType?: string
}) {
  const summary = summarizeApprovalRequest(request, nativeRequestType)
  return <Surface className="approval-request-summary">
    <h3>{summary.operation}</h3>
    {summary.command ? <p><strong>Command:</strong> <code>{summary.command}</code></p> : null}
    <p><strong>Target:</strong> {summary.target ?? 'Not supplied by the provider. Review technical details before deciding.'}</p>
    {summary.explanation ? <p><strong>Provider explanation:</strong> {summary.explanation}</p> : null}
    <Alert tone="warning" title="Review the response scope">Approval permits an attempt within the existing sandbox; it does not make the operation safe. Check choices affecting other requests or persistent policy.</Alert>
  </Surface>
}
