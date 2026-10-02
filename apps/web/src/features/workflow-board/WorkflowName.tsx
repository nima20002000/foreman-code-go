import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TextField } from '../../shared/ui/nocturne'

export function WorkflowName({ name, disabled, onRename, renderActions }: { name: string; disabled: boolean; onRename(name: string): void;
  renderActions?: (rename: () => void) => ReactNode }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const input = useRef<HTMLInputElement>(null)
  const active = useRef(false)
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])
  const finish = (save: boolean) => {
    if (!active.current) return
    active.current = false
    const next = value.trim()
    if (save && !disabled && next && next !== name) onRename(next)
    setEditing(false)
  }
  const begin = () => { setValue(name); active.current = true; setEditing(true) }
  return <>{editing ? <TextField ref={input} className="board-name-field" label="Workflow name" aria-label="Workflow name" value={value} disabled={disabled}
    onChange={(event) => setValue(event.target.value)} onBlur={() => finish(true)}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter')
      }
    }} /> : <h2><button className="board-name-button" title="Rename workflow" disabled={disabled}
      onClick={begin}>{name}</button></h2>}{renderActions?.(begin)}</>
}
