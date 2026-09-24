import { useEffect, useId, useRef, useState } from 'react'
import { changeCodexSandbox, OpenCodeHarnessConfigurationSchema, withAdvancedDefaults, type HarnessConfiguration, type OpenCodeAdvancedConfiguration } from '@graphql/contracts'
import { Button, ConfirmDialog, Icon, Select, TextField } from '../../shared/ui/nocturne'

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

export function OperatorAccessPicker({ value, disabled, saving = false, saveError, onChange }: {
  value: HarnessConfiguration
  disabled: boolean
  saving?: boolean
  saveError?: string
  onChange(value: HarnessConfiguration): Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<'sandbox' | 'approval'>()
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [rules, setRules] = useState<OpenCodeAdvancedConfiguration['permissionRules']>([])
  const [error, setError] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()
  const label = value.harness === 'codex'
    ? sandboxChoices.find((choice) => choice.value === value.sandbox)?.label ?? value.sandbox
    : `${value.advanced?.permissionRules.length ?? 0} OpenCode rule${value.advanced?.permissionRules.length === 1 ? '' : 's'}`
  function toggle() {
    if (!open && value.harness === 'opencode') setRules(structuredClone(value.advanced?.permissionRules ?? []))
    setError(undefined); setOpen(!open); setSubmenu(undefined)
  }
  function close() { clearTimeout(closeTimer.current); setSubmenu(undefined); setOpen(false) }
  async function save(next: HarnessConfiguration) {
    if (await onChange(next)) { close(); trigger.current?.focus() }
  }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !confirmFullAccess) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, confirmFullAccess])
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  return <div className="operator-access-picker" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape' && open && !confirmFullAccess) {
      event.preventDefault(); event.stopPropagation()
      if (submenu && value.harness === 'codex') { setSubmenu(undefined); root.current?.querySelector<HTMLButtonElement>(`[data-access-section="${submenu}"]`)?.focus() }
      else { close(); trigger.current?.focus() }
    }
  }} onPointerEnter={(event) => {
    clearTimeout(closeTimer.current)
    if (value.harness === 'codex' && !disabled && event.pointerType === 'mouse') setOpen(true)
  }} onPointerLeave={(event) => {
    if (value.harness === 'codex' && event.pointerType === 'mouse' && !confirmFullAccess) closeTimer.current = setTimeout(close, 180)
  }}>
    <button ref={trigger} className="operator-access-trigger" type="button" disabled={disabled}
      aria-label={`Operator access: ${label}`} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup={value.harness === 'codex' ? 'menu' : 'dialog'}
      onClick={() => value.harness === 'codex' ? setOpen(true) : toggle()}><Icon name="shield" size={16} /><span>{label}</span><Icon name="down" size={12} /></button>
    {open ? <div className={`operator-access-panel${value.harness === 'opencode' ? ' operator-access-panel-wide' : ' operator-access-menu'}`}
      role={value.harness === 'codex' ? 'menu' : 'dialog'} aria-label="Operator access" id={id}>
      {value.harness === 'opencode' ? <><strong>OpenCode access</strong><small>Saved to Operator defaults for future chats.</small></> : null}
      {saving ? <small role="status">Saving Operator access…</small> : null}
      {saveError ? <p role="alert">{saveError}</p> : null}
      {value.harness === 'codex' ? <><div className="operator-access-section">
        <button type="button" role="menuitem" data-access-section="sandbox" aria-haspopup="menu" aria-expanded={submenu === 'sandbox'}
          disabled={disabled} onPointerEnter={() => setSubmenu('sandbox')}
          onClick={() => setSubmenu('sandbox')} onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'Enter') { event.preventDefault(); setSubmenu('sandbox'); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-access-choice="sandbox"]')?.focus()) }
          }}>Codex sandbox<Icon name="chevron" size={13} /></button>
        {submenu === 'sandbox' ? <div className="operator-access-submenu" role="menu" aria-label="Codex sandbox">
        {sandboxChoices.map((choice) => <button type="button" role="menuitemradio" aria-checked={value.sandbox === choice.value}
          data-access-choice="sandbox" key={choice.value} disabled={disabled}
          onClick={() => {
            if (choice.value === value.sandbox) return
            if (choice.value === 'danger-full-access') { setConfirmFullAccess(true); return }
            void save(changeCodexSandbox(value, choice.value))
          }}><span>{choice.label}</span>{value.sandbox === choice.value ? <Icon name="check" size={14} /> : null}</button>)}
        </div> : null}</div>
        <div className="operator-access-section">
          <button type="button" role="menuitem" data-access-section="approval" aria-haspopup="menu" aria-expanded={submenu === 'approval'}
            disabled={disabled} onPointerEnter={() => setSubmenu('approval')}
            onClick={() => setSubmenu('approval')} onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'Enter') { event.preventDefault(); setSubmenu('approval'); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-access-choice="approval"]')?.focus()) }
            }}>Approval requests<Icon name="chevron" size={13} /></button>
          {submenu === 'approval' ? <div className="operator-access-submenu" role="menu" aria-label="Approval requests">
          {(['on-request', 'never'] as const).map((policy) => <button key={policy} type="button" role="menuitemradio"
            data-access-choice="approval" aria-checked={(withAdvancedDefaults(value).advanced?.approvalPolicy ?? 'on-request') === policy} disabled={disabled}
            onClick={() => { const current = withAdvancedDefaults(value); void save({ ...current, advanced: { ...current.advanced!, approvalPolicy: policy } }) }}>
            <span>{policy === 'on-request' ? 'Ask when needed' : 'Never request escalation'}</span>
            {(withAdvancedDefaults(value).advanced?.approvalPolicy ?? 'on-request') === policy ? <Icon name="check" size={14} /> : null}
          </button>)}
          </div> : null}</div>
      </> : <>
        <p>OpenCode permissions control whether tools ask, run, or are denied. They are not a filesystem sandbox. Last matching rule wins.</p>
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
          {rules.length === 0 ? <small>Using native rules. Add a rule to override an action.</small> : null}
        </div>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setRules([...rules, { permission: 'shell', pattern: '*', effect: 'ask' }])}>Add rule</Button>
        {error ? <p role="alert">{error}</p> : null}
        <div className="operator-access-footer"><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={disabled || JSON.stringify(rules) === JSON.stringify(value.advanced?.permissionRules ?? [])}
            onClick={() => {
              const normalized = withAdvancedDefaults(value)
              const next = OpenCodeHarnessConfigurationSchema.safeParse({ ...normalized, advanced: { ...normalized.advanced, permissionRules: rules } })
              if (!next.success) { setError('Enter a permission and pattern for every rule.'); return }
              setError(undefined); void save(next.data)
            }}>Save access rules</Button></div>
      </>}
    </div> : null}
    <ConfirmDialog open={confirmFullAccess} onOpenChange={setConfirmFullAccess} title="Allow full access?"
      description="Codex commands will run without its filesystem or network sandbox. This does not change approval routing."
      confirmation="full access" confirmLabel="Use full access" onConfirm={() => {
        if (value.harness === 'codex') void save(changeCodexSandbox(value, 'danger-full-access'))
        setConfirmFullAccess(false)
      }} />
  </div>
}
