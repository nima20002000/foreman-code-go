import type { Message } from '@graphql/contracts'
import './conversationHistory.css'

export interface ConversationHistoryProps {
  messages: Message[]
}

export function ConversationHistory({ messages }: ConversationHistoryProps) {
  if (messages.length === 0) {
    return <p data-testid="conversation-empty">No conversation history yet.</p>
  }

  return (
    <ol aria-label="Conversation history">
      {messages.map((message) => (
        <li key={message.id} data-message-role={message.role}>
          <strong>{message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'You' : message.role}</strong>
          <p className="conversation-message-content">{message.content}</p>
        </li>
      ))}
    </ol>
  )
}
