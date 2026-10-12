import type { AgentChatSourceTranscript } from '@foreman-code/contracts/agent-chat'
import { Badge, MessageBubble } from '../../../shared/ui/nocturne'
import { TextTruncationNotice } from '../TextTruncationNotice'

export function RunTranscript({ transcript, name }: { transcript: AgentChatSourceTranscript; name: string }) {
  return <section aria-label="Workflow execution transcript">
    <p role="status">Workflow execution · {transcript.state}</p>
    {transcript.hasEarlierMessages ? <p>Showing the latest 100 execution messages.</p> : null}
    {!transcript.messages.length ? <p>No public messages have been received from this execution yet.</p> : null}
    <ol aria-label="Execution messages">
      {transcript.messages.map(message => <li key={message.id}>
        <MessageBubble role={message.role === 'user' ? 'user' : 'assistant'}
          author={message.role === 'user' ? 'You' : name}
          status={message.nativeMessageComplete === false ? <Badge>Partial message</Badge> : undefined}>
          <p className="conversation-message-content">{message.content}</p>
          <TextTruncationNotice truncation={message.truncation} />
        </MessageBubble>
      </li>)}
    </ol>
  </section>
}
