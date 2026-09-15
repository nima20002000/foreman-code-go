import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HarnessDefaults } from '@graphql/contracts'

import {
  queryKeys,
  useHarnessDefaultsQuery,
  useSaveHarnessDefaultsMutation,
} from '../../shared/api/query'
import {
  CODEX_MODELS,
  OPENCODE_MODELS,
  effortLabels,
  effortOptions,
} from '../agents/agentSettings'

export function HarnessDefaultsSettings() {
  const queryClient = useQueryClient()
  const defaultsQuery = useHarnessDefaultsQuery()
  const saveMutation = useSaveHarnessDefaultsMutation()
  const [draft, setDraft] = useState<HarnessDefaults>()

  useEffect(() => {
    const defaults = defaultsQuery.data?.defaults
    // Initial hydration only: background refetches must not overwrite edits.
    if (defaults) setDraft((current) => current ?? {
      ...defaults,
      opencode: { ...defaults.opencode, autoApprove: false },
    })
  }, [defaultsQuery.data?.defaults])

  if (defaultsQuery.isError) {
    return (
      <div className="settings-state settings-state-error" role="alert">
        <p>Harness defaults are unavailable.</p>
        <button type="button" onClick={() => void defaultsQuery.refetch()}>Retry</button>
      </div>
    )
  }

  if (defaultsQuery.isPending || !draft) {
    return <p className="settings-state" role="status">Loading harness defaults…</p>
  }

  const isDirty = JSON.stringify(draft) !== JSON.stringify(defaultsQuery.data.defaults)
  const save = () => {
    if (saveMutation.isPending) return
    saveMutation.mutate({ defaults: draft }, {
      onSuccess: (response) => {
        setDraft(response.defaults)
        queryClient.setQueryData(queryKeys.harnessDefaults, response)
      },
    })
  }

  return (
    <section className="harness-defaults" aria-labelledby="harness-defaults-title">
      <div className="harness-defaults-heading">
        <div>
          <h2 id="harness-defaults-title">Harness defaults</h2>
          <p>New board agents copy these settings. Existing agents do not change.</p>
        </div>
        <button type="button" onClick={save} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? 'Saving…' : 'Save defaults'}
        </button>
      </div>

      <div className="harness-defaults-grid">
        <fieldset disabled={saveMutation.isPending}>
          <legend>Codex</legend>
          <div className="settings-control"><span>Model</span><select aria-label="Codex model" value={draft.codex.model} onChange={(event) => {
            const model = event.target.value
            const efforts = effortOptions('codex', model)
            setDraft({
              ...draft,
              codex: {
                ...draft.codex,
                model,
                reasoningEffort: efforts.includes(draft.codex.reasoningEffort)
                  ? draft.codex.reasoningEffort
                  : 'max',
              },
            })
          }}>
            {CODEX_MODELS.map((model) => <option value={model} key={model}>{model}</option>)}
          </select></div>
          <div className="settings-control"><span>Effort</span><select aria-label="Codex effort" value={draft.codex.reasoningEffort} onChange={(event) => setDraft({
            ...draft,
            codex: { ...draft.codex, reasoningEffort: event.target.value as typeof draft.codex.reasoningEffort },
          })}>
            {effortOptions('codex', draft.codex.model).map((effort) => <option value={effort} key={effort}>{effortLabels[effort]}</option>)}
          </select></div>
          <div className="settings-control"><span>Sandbox</span><select aria-label="Codex sandbox" value={draft.codex.sandbox} onChange={(event) => setDraft({
            ...draft,
            codex: { ...draft.codex, sandbox: event.target.value as typeof draft.codex.sandbox },
          })}>
            <option value="read-only">Read only</option>
            <option value="workspace-write">Workspace write</option>
          </select></div>
          <label className="settings-switch">
            <input type="checkbox" checked={draft.codex.serviceTier === 'priority'} onChange={(event) => setDraft({
              ...draft,
              codex: { ...draft.codex, serviceTier: event.target.checked ? 'priority' : 'standard' },
            })} />
            Fast mode
          </label>
        </fieldset>

        <fieldset disabled={saveMutation.isPending}>
          <legend>OpenCode</legend>
          <div className="settings-control"><span>Model</span><select aria-label="OpenCode model" value={draft.opencode.model} onChange={(event) => setDraft({
            ...draft,
            opencode: { ...draft.opencode, model: event.target.value },
          })}>
            {OPENCODE_MODELS.map((model) => <option value={model} key={model}>{model}</option>)}
          </select></div>
          <div className="settings-control"><span>Variant</span><select aria-label="OpenCode variant" value={draft.opencode.variant} onChange={(event) => setDraft({
            ...draft,
            opencode: { ...draft.opencode, variant: event.target.value as typeof draft.opencode.variant },
          })}>
            {(['low', 'high', 'max'] as const).map((variant) => <option value={variant} key={variant}>{effortLabels[variant]}</option>)}
          </select></div>
          <div className="settings-control"><span>Native agent</span><input aria-label="OpenCode native agent" value={draft.opencode.nativeAgent} onChange={(event) => setDraft({
            ...draft,
            opencode: { ...draft.opencode, nativeAgent: event.target.value },
          })} /></div>
          <label className="settings-switch">
            <input type="checkbox" checked={draft.opencode.thinking} onChange={(event) => setDraft({
              ...draft,
              opencode: { ...draft.opencode, thinking: event.target.checked },
            })} />
            Show thinking
          </label>
          <label className="settings-switch">
            <input type="checkbox" checked={false} disabled />
            Auto-approve permissions (not supported)
          </label>
        </fieldset>
      </div>

      {saveMutation.isSuccess && !isDirty ? <p className="settings-save-status" role="status">Defaults saved.</p> : null}
      {isDirty && !saveMutation.isPending ? <p className="settings-save-status" role="status">Unsaved changes.</p> : null}
      {saveMutation.isError ? <p className="settings-save-status settings-state-error" role="alert">Defaults could not be saved.</p> : null}
    </section>
  )
}
