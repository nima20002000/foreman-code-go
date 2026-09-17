import { useEffect, useState, useSyncExternalStore } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { getOperatorConversationHistory } from '../../shared/api/operatorChatHistory'
import { identityChangedEvent, identityEpoch } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { Button } from '../../shared/ui/nocturne'
import { ConversationHistory } from '../conversations'
import { useOperatorChatStore } from './operatorChatStore'

function subscribeIdentity(listener: () => void) {
  window.addEventListener(identityChangedEvent, listener)
  return () => window.removeEventListener(identityChangedEvent, listener)
}

/** This is server state, not an outbox. Session changes still erase local plaintext. */
export function OperatorHistory({ onBrowse }: { onBrowse?: () => void }) {
  const id = useOperatorChatStore((state) => state.selectedConversationId)
  const epoch = useSyncExternalStore(subscribeIdentity, identityEpoch, () => 'server')
  if (!id || sessionIsSwitching()) return null
  return <OwnedHistory key={`${epoch}:${id}`} id={id} epoch={epoch} onBrowse={onBrowse} />
}

function OwnedHistory({ id, epoch, onBrowse }: { id: string; epoch: string; onBrowse: (() => void) | undefined }) {
  const [open, setOpen] = useState(false)
  const client = useQueryClient()
  const key = ['operator-chat', 'history', epoch, id] as const
  const history = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => getOperatorConversationHistory(id, pageParam ? { before: pageParam } : {}, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
    retry: false,
  })
  useEffect(() => {
    // Immediately discard old-owner pages, including when identity changes in
    // another tab. The shared HTTP boundary also rejects late responses.
    const clear = () => {
      const queryKey = ['operator-chat', 'history', epoch, id]
      void client.cancelQueries({ queryKey })
      client.removeQueries({ queryKey })
    }
    window.addEventListener(identityChangedEvent, clear)
    return () => { window.removeEventListener(identityChangedEvent, clear); clear() }
  }, [client, epoch, id])

  return <section aria-label="Full Operator history">
    <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => { if (!open) onBrowse?.(); setOpen(!open) }}>
      {open ? 'Hide full history' : 'Full history and accepted request IDs'}
    </Button>
    {open ? <div>
      <p>These are saved server receipts, not commands to resend. An unfinished receipt does not prove delivery failed.</p>
      {history.isPending ? <p role="status">Loading history…</p> : null}
      {history.isError ? <p role="alert">History could not be loaded. Your command was not resent.</p> : null}
      <Button size="sm" variant="secondary" disabled={history.isFetching}
        onClick={() => { void history.refetch() }}>Refresh receipts</Button>
      {history.hasNextPage ? <Button size="sm" variant="secondary" disabled={history.isFetching}
        onClick={() => { void history.fetchNextPage() }}>Load older messages</Button> : null}
      {[...(history.data?.pages ?? [])].reverse().flatMap((page) => page.entries).map((entry) =>
        <div key={entry.sequence}>
          <ConversationHistory messages={[entry.message]} />
          {entry.receipt ? <p>
            Accepted request: <code>{entry.receipt.requestId}</code>
            {' — '}{entry.receipt.outcome ?? 'No terminal receipt yet'}
          </p> : null}
        </div>)}
    </div> : null}
  </section>
}
