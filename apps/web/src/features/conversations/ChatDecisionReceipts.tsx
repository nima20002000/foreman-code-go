import type { ActivitySnapshotV1 } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne'

export function ChatDecisionReceipts({ snapshot, onRefresh, pending = false }: {
  snapshot?: ActivitySnapshotV1; onRefresh(): void; pending?: boolean
}) {
  const receipts = [...new Map([...(snapshot?.activities.flatMap((item) => item.kind === 'interaction' ? [item.interaction] : []) ?? []),
    ...(snapshot?.pendingInteractions ?? [])].map((receipt) => [receipt.id, receipt])).values()]
    .filter((receipt) => receipt.answerRecorded || receipt.providerAcknowledged)
  if (!receipts.length && !snapshot?.hasMorePendingInteractions) return null
  const needsAttention = receipts.some(receipt => !receipt.providerAcknowledged)
  return <section aria-label="Recorded decisions">
    {receipts.map((receipt) => <div key={receipt.id} role="status">
      <strong>{receipt.providerAcknowledged ? 'Decision delivered' : receipt.delivery === 'uncertain'
        ? 'Decision delivery unconfirmed' : receipt.delivery === 'failed' ? 'Decision delivery failed' : 'Decision sending'}</strong>
      {!receipt.providerAcknowledged ? <p>Your decision is saved. Check its status before submitting again.</p> : null}
      <details><summary>Delivery details</summary>
        <p>{receipt.providerAcknowledged ? 'The provider acknowledged this decision.' : 'Delivery to the provider is not confirmed.'}
          {receipt.workerAcknowledged ? ' The worker acknowledged it.' : ' This does not confirm work completion.'}</p><dl>
        <dt>Request</dt><dd>{receipt.native?.requestId ?? receipt.id}</dd>
        {receipt.owner.kind === 'chat_request' ? <><dt>Message request</dt><dd>{receipt.owner.requestId}</dd></> : null}
      </dl></details>
    </div>)}
    {snapshot?.hasMorePendingInteractions ? <p>Some older decision receipts are outside this view.</p> : null}
    {needsAttention || snapshot?.hasMorePendingInteractions
      ? <Button size="sm" disabled={pending} onClick={onRefresh}>Refresh decision status</Button> : null}
  </section>
}
