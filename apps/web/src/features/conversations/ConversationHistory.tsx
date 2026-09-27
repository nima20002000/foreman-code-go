import type { ReactNode } from 'react'
import type { Message } from '@graphql/contracts'
import { EmptyState, MessageBubble } from '../../shared/ui/nocturne'
import './conversationHistory.css'

export interface ConversationHistoryProps {
  messages: Message[]
  assistantName?: string
  renderBefore?: (message: Message) => ReactNode
  renderAfter?: (message: Message) => ReactNode
  renderStatus?: (message: Message) => ReactNode
  renderActions?: (message: Message) => ReactNode
}

export function ConversationHistory({ messages, assistantName = 'Assistant', renderBefore, renderAfter, renderStatus, renderActions }: ConversationHistoryProps) {
  if (messages.length === 0) {
    return <div data-testid="conversation-empty"><EmptyState icon="history" title="No conversation history yet" description="Messages will appear here after the conversation starts." /></div>
  }

  return (
    <ol aria-label="Conversation history">
      {messages.map((message) => (
        <li key={message.id} data-message-role={message.role}>
          {renderBefore?.(message)}
          <MessageBubble
            author={message.role === 'assistant' ? assistantName : message.role === 'user' ? 'You' : message.role}
            role={message.role === 'assistant' || message.role === 'user' ? message.role : 'system'}
            status={renderStatus?.(message)}
            actions={renderActions?.(message)}
          >
            <p className="conversation-message-content">{message.content}</p>
          </MessageBubble>
          {renderAfter?.(message)}
        </li>
      ))}
    </ol>
  )
}
