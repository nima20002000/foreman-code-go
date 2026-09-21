import type { DurableInteraction } from '@graphql/contracts'
import { summarizeApprovalRequest } from './approvalPresentation'
import './approvalSummary.css'

export function ApprovalRequestSummary({ request, nativeRequestType, reviewContext }: {
  request: DurableInteraction['request']
  nativeRequestType?: string
  reviewContext?: DurableInteraction['reviewContext']
}) {
  const summary = summarizeApprovalRequest(request, nativeRequestType)
  const target = reviewContext?.target ?? summary.target
  return <section className="approval-request-summary">
    {summary.command ? <code>{summary.command}</code> : target ? <strong>{target}</strong> : <p>Target not provided.</p>}
    {summary.command && target ? <p>{target}</p> : null}
    {reviewContext?.changeSummary ? <p>{reviewContext.changeSummary}</p> : null}
    {summary.explanation ? <p>{summary.explanation}</p> : null}
  </section>
}
