import { useId, useState } from 'react'

export interface TerminalPlaceholderProps {
  /** Keep the initial state deterministic for the shell and its tests. */
  defaultExpanded?: boolean
}

/**
 * A deliberately small terminal boundary for the wireframe phase.
 *
 * There is no terminal transport behind this component yet. In particular, it
 * does not render a prompt or accept input that could imply a connected shell.
 */
export function TerminalPlaceholder({
  defaultExpanded = false,
}: TerminalPlaceholderProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const contentId = useId()

  return (
    <section
      className="terminal-placeholder"
      data-testid="terminal-placeholder"
      aria-labelledby={`${contentId}-title`}
    >
      <div className="terminal-heading">
        <div>
          <p className="panel-kicker">Terminal</p>
          <h2 id={`${contentId}-title`}>No terminal connected</h2>
        </div>
        <button
          type="button"
          className="disclosure-button"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {expanded ? (
        <div id={contentId} className="terminal-content">
          <p>
            Connect a runner to open a terminal for this workspace. Terminal
            input is unavailable until then.
          </p>
        </div>
      ) : null}
    </section>
  )
}
