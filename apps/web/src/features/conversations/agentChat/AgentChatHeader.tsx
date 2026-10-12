import type { ReactNode } from 'react'
import { Icon, IconButton, Tooltip } from '../../../shared/ui/nocturne'

export function AgentChatHeader({ name, role = 'Agent', state, detail, onClose }: {
  name: string; role?: string; state: string; detail?: string; onClose?: () => void
}) {
  const chip = <span className="agent-chat-session-label" data-state={state} role="status" aria-label="Agent state"
    tabIndex={detail ? 0 : undefined}>{state}</span>
  return <header className="agent-chat-header">
    <div className="agent-chat-identity"><h2>{name}</h2><span>{role}</span></div>
    {detail ? <Tooltip content={detail}>{chip}</Tooltip> : chip}
    {onClose ? <IconButton label={`Close ${name}`} variant="ghost" onClick={onClose}>
      <Icon name="close" size={16} />
    </IconButton> : null}
  </header>
}

export function AgentChatStatus({ children }: { children?: ReactNode }) {
  return children ? <div className="agent-chat-status" role="status">{children}</div> : null
}
