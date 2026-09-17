import { useId, useRef, useState } from 'react'
import type { OpenCodeAdvancedConfiguration } from '@graphql/contracts'
import { Button, Select, TextField } from '../../shared/ui/nocturne'
import { fieldMessage, type FieldIssue } from './fieldValidation'

export function HarnessPermissionRules({ value, onChange, issues }: {
  value: OpenCodeAdvancedConfiguration['permissionRules'];
  onChange(value: OpenCodeAdvancedConfiguration['permissionRules']): void;
  issues: readonly FieldIssue[];
}) {
  const prefix = useId()
  const serial = useRef(0)
  const [keys, setKeys] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const rows = value.map((_, index) => keys[index] ?? `${prefix}-${index}`)
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= value.length) return
    const next = [...value]; const identifiers = [...rows]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    ;[identifiers[index], identifiers[target]] = [identifiers[target]!, identifiers[index]!]
    setKeys(identifiers); onChange(next)
    setAnnouncement(`Rule moved to position ${target + 1}.`)
    requestAnimationFrame(() => document.getElementById(`${identifiers[target]}-permission`)?.focus())
  }
  return <section aria-label="Permission rules" className="harness-permission-rules">
    <div className="harness-section-heading"><h4>Permission rules</h4><span className="harness-muted">Last matching rule wins.</span></div>
    {value.map((rule, index) => <div className="harness-rule" key={rows[index]}>
      <span className="harness-rule-number" aria-label={`Rule ${index + 1}`}>{index + 1}</span>
      <TextField id={`${rows[index]}-permission`} label="Permission" aria-label={`Permission ${index + 1}`} value={rule.permission} error={fieldMessage(issues, `advanced.permissionRules.${index}.permission`)}
        onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, permission: event.target.value } : entry))} />
      <TextField label="Pattern" aria-label={`Pattern ${index + 1}`} value={rule.pattern} error={fieldMessage(issues, `advanced.permissionRules.${index}.pattern`)}
        onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, pattern: event.target.value } : entry))} />
      <Select label="Effect" aria-label={`Effect ${index + 1}`} value={rule.effect} options={['ask', 'allow', 'deny'].map((effect) => ({ value: effect, label: effect === 'ask' ? 'Ask' : effect === 'allow' ? 'Allow' : 'Deny' }))}
        onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, effect: event.target.value as typeof entry.effect } : entry))} />
      <div className="harness-inline-actions"><Button size="sm" aria-label={`Move permission rule ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
        <Button size="sm" aria-label={`Move permission rule ${index + 1} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}>↓</Button>
        <Button size="sm" aria-label={`Remove permission rule ${index + 1}`} onClick={() => { setKeys(rows.filter((_, at) => at !== index)); onChange(value.filter((_, at) => at !== index)) }}>Remove</Button></div>
    </div>)}
    {value.length === 0 ? <p className="harness-muted">Using native permission rules.</p> : null}
    <Button size="sm" onClick={() => {
      const key = `${prefix}-new-${serial.current++}`
      setKeys([...rows, key]); onChange([...value, { permission: 'shell', pattern: '*', effect: 'ask' }])
      requestAnimationFrame(() => document.getElementById(`${key}-permission`)?.focus())
    }}>Add custom rule</Button><small>Rules retain order and patterns exactly. Moving a rule changes its priority.</small><span className="visually-hidden" role="status">{announcement}</span>
  </section>
}
