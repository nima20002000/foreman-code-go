import type { OperatorActivity } from '@foreman-code/contracts'
import { ChevronRight, Terminal } from 'lucide-react'
import { CodeBlock } from '../../../shared/ui/nocturne'

const verbs: Record<OperatorActivity['kind'], string> = {
  thinking: '', tool: 'Ran', mcp: 'Called', web_search: 'Searched',
  file_read: 'Read', file_write: 'Wrote', subagent: 'Agent',
}
const statuses: Record<OperatorActivity['status'], string> = {
  pending: 'Waiting', running: 'Running', completed: '', failed: 'Failed', canceled: 'Stopped', unknown: 'Unconfirmed',
}

export function AgentChatActivity({ entry, onBrowse }: { entry: OperatorActivity; onBrowse(): void }) {
  const verb = verbs[entry.kind]
  const title = entry.title.toLowerCase().startsWith(`${verb.toLowerCase()} `)
    ? entry.title : `${verb} ${entry.title}`
  return <details className="agent-chat-tool" data-activity-kind={entry.kind}
    onClickCapture={event => { if ((event.target as HTMLElement).closest('summary')) onBrowse() }}>
    <summary>
      <Terminal size={13} aria-hidden="true" />
      <span title={title}>{title}</span>
      {statuses[entry.status] ? <small>{statuses[entry.status]}</small> : null}
      <ChevronRight size={13} className="agent-chat-tool-chevron" aria-hidden="true" />
    </summary>
    <div className="agent-chat-tool-content">
      {entry.input ? <CodeBlock code={entry.input} label="Input" /> : null}
      {entry.output ? <CodeBlock code={entry.output} label="Output" /> : null}
      {!entry.input && !entry.output ? <p>Details unavailable.</p> : null}
      {entry.truncated ? <small>Details shortened.</small> : null}
    </div>
  </details>
}
