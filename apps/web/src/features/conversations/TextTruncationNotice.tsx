import type { Message } from '@graphql/contracts'

export function TextTruncationNotice({ truncation }: { truncation?: Message['truncation'] }) {
  if (!truncation?.truncated) return null
  return <p role="note" aria-label="Shortened message" className="conversation-message-truncation">
    This message was shortened. The remaining text is not shown.
  </p>
}
