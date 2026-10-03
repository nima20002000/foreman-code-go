import { useState } from 'react'
import { changeCodexSandbox, OpenCodeHarnessConfigurationSchema, withAdvancedDefaults, type HarnessConfiguration, type OpenCodeAdvancedConfiguration } from '@graphql/contracts'
import { Button, Select, TextField } from '../../shared/ui/nocturne'

const sandboxChoices = [
  { value: 'read-only', label: 'Read only' },
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'danger-full-access', label: 'Full access' },
] as const
const ruleEffects = [
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
] as const

/** Access shares the agent dialog and revisioned Operator defaults. */
export function OperatorAccessPicker({ value, disabled, saving = false, saveError, onChange }: {
  value: HarnessConfiguration; disabled: boolean; saving?: boolean; saveError?: string
  onChange(value: HarnessConfiguration): Promise<boolean>
}) {
  const [rules, setRules] = useState<OpenCodeAdvancedConfiguration['permissionRules']>(value.harness === 'opencode' ? structuredClone(value.advanced?.permissionRules ?? []) : [])
  const [error, setError] = useState<string>()
  return <div className="operator-access-inline" role="group" aria-label="Operator access">
    <small>Access changes apply to new chats and harness handoffs. Existing chats keep their accepted access policy.</small>
    {saving ? <small role="status">Saving Operator access…</small> : null}
    {saveError ? <p role="alert">{saveError}</p> : null}
    {value.harness === 'codex' || value.harness === 'claude' ? <Select label="Sandbox" value={value.sandbox} options={sandboxChoices} disabled={disabled}
      onChange={(event) => {
        const choice = sandboxChoices.find((item) => item.value === event.target.value)
        if (choice) void onChange(value.harness === 'codex' ? changeCodexSandbox(value, choice.value) : { ...value, sandbox: choice.value })
      }} /> : null}
    {value.harness === 'codex' ? <Select label="Approval requests" value={withAdvancedDefaults(value).advanced?.approvalPolicy ?? 'on-request'} disabled={disabled}
      options={[{ value: 'on-request', label: 'Ask when needed' }, { value: 'never', label: 'Never request escalation' }]}
      onChange={(event) => {
        const current = withAdvancedDefaults(value)
        if (event.target.value === 'on-request' || event.target.value === 'never') void onChange({ ...current, advanced: { ...current.advanced!, approvalPolicy: event.target.value } })
      }} /> : null}
    {value.harness === 'opencode' ? <>
      <strong>OpenCode permissions</strong><p>Native tool permissions; no filesystem sandbox. Last matching rule wins.</p>
      <div className="operator-access-rules">
        {rules.map((rule, index) => <div className="operator-access-rule" key={index}>
          <TextField label="Permission" aria-label={`Permission ${index + 1}`} value={rule.permission} disabled={disabled}
            onChange={(event) => setRules(rules.map((item, at) => at === index ? { ...item, permission: event.target.value } : item))} />
          <TextField label="Pattern" aria-label={`Pattern ${index + 1}`} value={rule.pattern} disabled={disabled}
            onChange={(event) => setRules(rules.map((item, at) => at === index ? { ...item, pattern: event.target.value } : item))} />
          <Select label="Action" aria-label={`Action ${index + 1}`} value={rule.effect} disabled={disabled} options={ruleEffects}
            onChange={(event) => setRules(rules.map((item, at) => at === index ? { ...item, effect: event.target.value as OpenCodeAdvancedConfiguration['permissionRules'][number]['effect'] } : item))} />
          <div className="operator-access-rule-actions">
            <Button size="sm" variant="ghost" aria-label={`Move rule ${index + 1} up`} disabled={disabled || index === 0}
              onClick={() => setRules((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next })}>↑</Button>
            <Button size="sm" variant="ghost" aria-label={`Move rule ${index + 1} down`} disabled={disabled || index === rules.length - 1}
              onClick={() => setRules((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; return next })}>↓</Button>
            <Button size="sm" variant="ghost" aria-label={`Remove rule ${index + 1}`} disabled={disabled}
              onClick={() => setRules(rules.filter((_, at) => at !== index))}>Remove</Button>
          </div>
        </div>)}
        {rules.length === 0 ? <small>Using native rules.</small> : null}
      </div>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setRules([...rules, { permission: 'shell', pattern: '*', effect: 'ask' }])}>Add rule</Button>
      {error ? <p role="alert">{error}</p> : null}
      <div className="operator-access-footer"><Button size="sm" variant="ghost" disabled={disabled}
        onClick={() => { setRules(structuredClone(value.advanced?.permissionRules ?? [])); setError(undefined) }}>Discard rule changes</Button>
        <Button size="sm" variant="primary" disabled={disabled || JSON.stringify(rules) === JSON.stringify(value.advanced?.permissionRules ?? [])}
          onClick={() => {
            const normalized = withAdvancedDefaults(value)
            const next = OpenCodeHarnessConfigurationSchema.safeParse({ ...normalized, advanced: { ...normalized.advanced, permissionRules: rules } })
            if (!next.success) { setError('Enter a permission and pattern for every rule.'); return }
            setError(undefined); void onChange(next.data)
          }}>Save access rules</Button></div>
    </> : null}
  </div>
}
