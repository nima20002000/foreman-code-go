import { useId, useRef, useState } from 'react'
import type { OpenCodeAdvancedConfiguration } from '@foreman-code/contracts'
import { Button, Icon, IconButton, Select, TextField } from '../../shared/ui/nocturne'
import { fieldMessage, type FieldIssue } from './fieldValidation'
import './harnessPermissionRules.css'

export function HarnessPermissionRules({ value, onChange, issues }: {
  value: OpenCodeAdvancedConfiguration['permissionRules'];
  onChange(value: OpenCodeAdvancedConfiguration['permissionRules']): void;
  issues: readonly FieldIssue[];
}) {
  const prefix = useId()
  const serial = useRef(0)
  const [keys, setKeys] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const rows = value.map((_, index) => {
    if (keys[index]) return keys[index]
    let key = `${prefix}-${index}`
    while (keys.includes(key)) key += '-restored'
    return key
  })
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= value.length) return
    const next = [...value]; const identifiers = [...rows]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    ;[identifiers[index], identifiers[target]] = [identifiers[target]!, identifiers[index]!]
    setKeys(identifiers); onChange(next)
    setAnnouncement(`Rule moved to position ${target + 1}. Later matching rules take priority.`)
    requestAnimationFrame(() => document.getElementById(`${identifiers[target]}-permission`)?.focus())
  }
  return <section aria-label="Permission rules" className="harness-permission-rules">
    <div className="harness-permission-heading">
      <div><h4>Permission rules <span className="harness-permission-count">{value.length}</span></h4><span className="harness-muted">Last matching rule wins.</span></div>
      <Button size="sm" leading={<Icon name="plus" size={14} />} onClick={() => {
        const key = `${prefix}-new-${serial.current++}`
        setKeys([...rows, key]); onChange([...value, { permission: 'shell', pattern: '*', effect: 'ask' }])
        setAnnouncement(`Ask rule added at position ${value.length + 1}.`)
        requestAnimationFrame(() => document.getElementById(`${key}-permission`)?.focus())
      }}>Add custom rule</Button>
    </div>
    {value.length ? <ol className="harness-permission-list">{value.map((rule, index) => <li className="harness-permission-rule" key={rows[index]}>
      <span className="harness-permission-number" aria-label={`Rule ${index + 1}`}>{index + 1}</span>
      <TextField id={`${rows[index]}-permission`} label="Permission" aria-label={`Permission ${index + 1}`} value={rule.permission} error={fieldMessage(issues, `advanced.permissionRules.${index}.permission`)}
        onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, permission: event.target.value } : entry))} />
      <TextField className="harness-permission-pattern" label="Pattern" aria-label={`Pattern ${index + 1}`} value={rule.pattern} error={fieldMessage(issues, `advanced.permissionRules.${index}.pattern`)}
        onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, pattern: event.target.value } : entry))} />
      <Select className="harness-permission-decision" label="Decision" aria-label={`Decision ${index + 1}`} value={rule.effect} error={fieldMessage(issues, `advanced.permissionRules.${index}.effect`)} options={['ask', 'allow', 'deny'].map((effect) => ({ value: effect, label: effect === 'ask' ? 'Ask' : effect === 'allow' ? 'Allow' : 'Deny' }))}
        onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, effect: event.target.value as typeof entry.effect } : entry))} />
      <div className="harness-permission-actions">
        <IconButton size="sm" variant="ghost" label={`Move permission rule ${index + 1} up`} title="Move earlier · lower priority" disabled={index === 0} onClick={() => move(index, -1)}><Icon className="harness-permission-up" name="arrow" size={15} /></IconButton>
        <IconButton size="sm" variant="ghost" label={`Move permission rule ${index + 1} down`} title="Move later · higher priority" disabled={index === value.length - 1} onClick={() => move(index, 1)}><Icon className="harness-permission-down" name="arrow" size={15} /></IconButton>
        <IconButton size="sm" variant="ghost" label={`Remove permission rule ${index + 1}`} onClick={() => {
          setKeys(rows.filter((_, at) => at !== index)); onChange(value.filter((_, at) => at !== index))
          setAnnouncement(`Rule ${index + 1} removed from this draft.`)
        }}><Icon name="trash" size={15} /></IconButton>
      </div>
    </li>)}</ol> : <div className="harness-permission-empty"><Icon name="shield" size={16} /><span>Native rules apply</span></div>}
    <details className="harness-permission-help"><summary>How rules work</summary><p>Rules retain their order and exact patterns, including wildcards and custom permissions. Moving a rule changes its priority. OpenCode permissions govern its tools; they are not an operating-system sandbox.</p></details>
    <span className="visually-hidden" role="status">{announcement}</span>
  </section>
}
