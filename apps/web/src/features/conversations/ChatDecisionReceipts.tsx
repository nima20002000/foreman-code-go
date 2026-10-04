import type { ActivitySnapshotV1 } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne'

/** A durable decision receipt is not another permission prompt or an instruction to resend. */
export function ChatDecisionReceipts({ snapshot, onRefresh, pending = false }: {
  snapshot?: ActivitySnapshotV1; onRefresh(): void; pending?: boolean
}) {
  const receipts = [...new Map([...(snapshot?.activities.flatMap((item) => item.kind === 'interaction' ? [item.interaction] : []) ?? []),
    ...(snapshot?.pendingInteractions ?? [])].map((receipt) => [receipt.id, receipt])).values()]
    .filter((receipt) => receipt.answerRecorded || receipt.providerAcknowledged)
  if (!receipts.length && !snapshot?.hasMorePendingInteractions) return null
  return <section aria-label="Recorded decisions">
    {receipts.map((receipt) => <div key={receipt.id} role="status">
      <strong>{receipt.providerAcknowledged ? 'Decision delivery acknowledged' : receipt.delivery === 'uncertain'
        ? 'Decision delivery unconfirmed' : receipt.delivery === 'failed' ? 'Decision delivery failed' : 'Decision recorded'}</strong>
      <p>{receipt.providerAcknowledged ? 'The provider acknowledged this decision.' : 'The decision is saved. Delivery to the provider is not confirmed.'}
        {receipt.workerAcknowledged ? ' The worker acknowledged it.' : ' Work completion is not confirmed by this receipt.'}</p>
      {!receipt.providerAcknowledged ? <p>Do not submit this decision again. Read back its current status.</p> : null}
      <details><summary>Decision receipt details</summary><dl>
        <dt>Request</dt><dd>{receipt.native?.requestId ?? receipt.id}</dd>
        {receipt.owner.kind === 'chat_request' ? <><dt>Message request</dt><dd>{receipt.owner.requestId}</dd></> : null}
      </dl></details>
    </div>)}
    {snapshot?.hasMorePendingInteractions ? <p>Some older decision receipts are outside this view.</p> : null}
    <Button size="sm" disabled={pending} onClick={onRefresh}>Refresh decision status</Button>
  </section>
}
