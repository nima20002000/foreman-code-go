import type { Message } from '@graphql/contracts'
import { EmptyState, MessageBubble } from '../../shared/ui/nocturne'
import './conversationHistory.css'

export interface ConversationHistoryProps {
  messages: Message[]
}

export function ConversationHistory({ messages }: ConversationHistoryProps) {
  if (messages.length === 0) {
    return <div data-testid="conversation-empty"><EmptyState icon="history" title="No conversation history yet" description="Messages will appear here after the conversation starts." /></div>
  }

  return (
    <ol aria-label="Conversation history">
      {messages.map((message) => (
        <li key={message.id} data-message-role={message.role}>
          <MessageBubble
            author={message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'You' : message.role}
            role={message.role === 'assistant' || message.role === 'user' ? message.role : 'system'}
          >
            <p className="conversation-message-content">{message.content}</p>
          </MessageBubble>
        </li>
      ))}
    </ol>
  )
}
