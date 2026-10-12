import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { Message } from '@foreman-code/contracts'
import { CodeBlock } from '../../../shared/ui/nocturne'
import { TextTruncationNotice } from '../TextTruncationNotice'

const markdownComponents: Components = {
  pre({ node }) {
    const code = node?.children[0]
    if (code?.type !== 'element') return null
    const text = code.children.map(child => child.type === 'text' ? child.value : '').join('')
    const classes = code.properties.className
    const language = Array.isArray(classes)
      ? classes.map(String).find(value => value.startsWith('language-'))?.slice(9) : undefined
    return <CodeBlock code={text.replace(/\n$/, '')} label="Code" language={language ?? 'text'} />
  },
  a({ children, href }) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  img({ alt }) {
    return <span>{alt}</span>
  },
}

export function AgentChatMessage({ message, name, status, actions, children }: {
  message: Omit<Message, 'conversationId'>
  name: string
  status?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  const user = message.role === 'user'
  const timestamp = message.createdAt
  const time = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined
  if (message.role === 'tool') return <details className="agent-chat-tool">
    <summary>Tool output</summary><CodeBlock code={message.content} label="Tool output" />
  </details>
  return <article className={`agent-chat-message agent-chat-message--${user ? 'user' : 'agent'}`}
    aria-label={`Message from ${user ? 'You' : name}`} data-message-role={message.role}>
    <div className="conversation-message-content">
      {user ? message.content : <Markdown components={markdownComponents} skipHtml>{message.content}</Markdown>}
    </div>
    <TextTruncationNotice truncation={message.truncation} />
    {children}
    <footer className="agent-chat-message-meta">
      {time ? <time dateTime={timestamp} title={new Date(timestamp!).toLocaleString()}>{time}</time> : null}
      {status}{actions}
    </footer>
  </article>
}
