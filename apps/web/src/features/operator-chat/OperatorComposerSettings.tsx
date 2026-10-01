import { useEffect, useId, useRef, useState } from 'react'
import { AgentHarnessSchema, AgentEffortSchema, operatorChatSettings, type OperatorChatSettings } from '@graphql/contracts'
import { useNativeHarnessOptions } from '../../shared/api/harnessSettings'
import { useHarnessDefaultsQuery } from '../../shared/api/query'
import { Button, Icon, SearchField, SegmentedControl, Slider, Switch } from '../../shared/ui/nocturne'
import { harnessNames } from '../settings/settingsPresentation'
import { supportedEfforts } from '../settings/harnessModelSelection'

export function OperatorComposerSettings({ value, onChange, disabled }: {
  value: OperatorChatSettings; onChange(value: OperatorChatSettings): void; disabled: boolean;
}) {
  const catalog = useNativeHarnessOptions(value.harness)
  const defaults = useHarnessDefaultsQuery()
  const [open, setOpen] = useState(false)
  const [choosingModel, setChoosingModel] = useState(false)
  const [search, setSearch] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const id = useId()
  const models = catalog.data?.models ?? []
  const model = models.find((item) => item.id === value.model)
  const modelName = model?.name || value.model.split('/').at(-1) || value.model
  const efforts: readonly string[] = value.harness === 'codex' ? supportedEfforts(model) : value.harness === 'opencode' ? model?.variants ?? [] : []
  const effort = value.harness === 'codex' ? value.reasoningEffort : value.harness === 'opencode' ? value.variant : ''
  const fastSupported = model?.serviceTiers.includes('priority') === true
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  useEffect(() => {
    if (disabled || !restoreFocus.current) return
    if (document.activeElement === document.body && restoreFocus.current.isConnected) restoreFocus.current.focus()
    restoreFocus.current = null
  }, [disabled])
  function update(next: OperatorChatSettings) {
    if (root.current?.contains(document.activeElement)) restoreFocus.current = document.activeElement as HTMLElement
    onChange(next)
  }
  function chooseModel(id: string) {
    const next = models.find((item) => item.id === id)
    if (!next) return
    if (value.harness === 'codex') {
      const allowed = supportedEfforts(next)
      update({ ...value, model: next.id, reasoningEffort: allowed.includes(value.reasoningEffort) ? value.reasoningEffort : allowed[0] ?? value.reasoningEffort,
        serviceTier: next.serviceTiers.includes(value.serviceTier) ? value.serviceTier : 'standard' })
    } else if (value.harness === 'opencode') update({ ...value, model: next.id, variant: next.variants.includes(value.variant) ? value.variant : '' })
    else update({ ...value, model: next.id })
    setChoosingModel(false)
  }
  return <div className="operator-agent-picker" ref={root} onKeyDown={(event) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault(); event.stopPropagation()
    if (choosingModel) setChoosingModel(false)
    else { setOpen(false); trigger.current?.focus() }
  }}>
    <button ref={trigger} type="button" className="operator-agent-trigger" aria-label={`Agent settings: ${modelName}${value.harness === 'claude' ? '' : `, ${effort || 'default effort'}`}${value.harness === 'codex' && value.serviceTier === 'priority' ? ', Fast' : ''}`}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" disabled={disabled}
      onClick={() => { setOpen(!open); setChoosingModel(false) }}>
      <span>{modelName}</span>{value.harness !== 'claude' ? <small>{effort || 'default'}</small> : null}{value.harness === 'codex' && value.serviceTier === 'priority' ? <small className="operator-fast-indicator">Fast</small> : null}<Icon name="down" size={13} />
    </button>
    {open ? <div className="operator-agent-panel" id={id} role="dialog" aria-label="Agent settings">
      <small>Saved to Operator defaults for your next message and future chats.</small>
      {choosingModel ? <>
        <Button size="sm" variant="ghost" leading={<Icon name="chevron" className="operator-chat-previous" size={14} />} onClick={() => setChoosingModel(false)}>Agent settings</Button>
        <SearchField autoFocus label="Search models" placeholder="Model name or ID" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="operator-model-list" aria-label="Models">
          {models.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(search.toLowerCase())).map((item) =>
            <button type="button" key={item.id} disabled={disabled} aria-pressed={item.id === value.model} onClick={() => chooseModel(item.id)}>
              <span>{item.name || item.id}<small>{item.id}</small></span>{item.id === value.model ? <Icon name="check" size={14} /> : null}
            </button>)}
          {!models.some((item) => `${item.id} ${item.name}`.toLowerCase().includes(search.toLowerCase())) ? <p>No models match.</p> : null}
        </div>
      </> : <>
        <SegmentedControl label="Harness" value={value.harness}
          options={AgentHarnessSchema.options.map((harness) => ({ value: harness, label: harnessNames[harness], disabled: disabled || !defaults.data?.defaults[harness] }))}
          onValueChange={(harness) => {
            const selected = AgentHarnessSchema.safeParse(harness)
            const preset = selected.success ? defaults.data?.defaults[selected.data] : undefined
            if (preset) update(operatorChatSettings(preset, value.showThinking))
          }} />
        <button className="operator-model-choice" type="button" disabled={disabled || !catalog.isSuccess} onClick={() => { setChoosingModel(true); setSearch('') }}>
          <span>{modelName}<small>Choose model</small></span><Icon name="chevron" size={14} />
        </button>
        {defaults.data && !defaults.data.defaults.claude ? <small>Configure a Claude profile in Harness settings before switching to Claude.</small> : null}
        {value.harness !== 'claude' ? <Slider label="Effort" min={0} max={Math.max(0, efforts.length - 1)} step={1}
          value={Math.max(0, efforts.indexOf(effort))} disabled={disabled || efforts.length < 2}
          format={(index) => efforts.includes(effort) ? efforts[index] ?? 'Default' : effort || 'Default'}
          onValueChange={(index) => {
            const next = efforts[index]
            if (!next) return
            if (value.harness === 'codex') {
              const effort = AgentEffortSchema.safeParse(next)
              if (effort.success) update({ ...value, reasoningEffort: effort.data })
            } else if (value.harness === 'opencode') update({ ...value, variant: next })
          }} /> : null}
        {value.harness !== 'claude' ? <Switch label="Fast mode" checked={value.harness === 'codex' && value.serviceTier === 'priority'}
          disabled={disabled || value.harness !== 'codex' || (!fastSupported && value.serviceTier !== 'priority')}
          onChange={(event) => { if (value.harness === 'codex') update({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' }) }} /> : <small>Claude has no effort or Fast mode setting in this configuration.</small>}
        {value.harness === 'opencode' ? <small>Fast mode is not available in OpenCode.</small> : null}
        <Switch label="Show thinking" checked={value.showThinking} disabled={disabled} onChange={(event) => update({ ...value, showThinking: event.target.checked })} />
        {catalog.isPending ? <small role="status">Loading models…</small> : null}
        {catalog.isError || defaults.isError ? <div role="alert">Settings unavailable. <Button size="sm" onClick={() => { void catalog.refetch(); void defaults.refetch() }}>Retry</Button></div> : null}
      </>}
    </div> : null}
  </div>
}
