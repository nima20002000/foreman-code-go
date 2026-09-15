import { useRef, useState } from 'react'
import { useRevisionedForm } from './revisionedForm'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useQueryClient } from '@tanstack/react-query'
import type { HarnessDefaults } from '@graphql/contracts'

import {
  queryKeys,
  useHarnessDefaultsQuery,
  useManagedHarnessCatalogQuery,
  useSaveHarnessDefaultsMutation,
  useUpdateManagedHarnessDefaultsMutation,
} from '../../shared/api/query'
import {
  CODEX_MODELS,
  OPENCODE_MODELS,
  effortLabels,
  effortOptions,
} from '../agents/agentSettings'

function defaultsFromCatalog(catalog: ReturnType<typeof useManagedHarnessCatalogQuery>['data']): HarnessDefaults | undefined {
  const codex = catalog?.find((entry) => entry.harness === 'codex')?.defaults
  const opencode = catalog?.find((entry) => entry.harness === 'opencode')?.defaults
  return codex?.harness === 'codex' && opencode?.harness === 'opencode' ? { codex, opencode } : undefined
}

export function HarnessDefaultsSettings() {
  const realMode = import.meta.env.MODE !== 'test' && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false')
  const queryClient = useQueryClient()
  const defaultsQuery = useHarnessDefaultsQuery({ enabled: !realMode })
  const catalogQuery = useManagedHarnessCatalogQuery(realMode)
  const saveMutation = useSaveHarnessDefaultsMutation()
  const managedSaveMutation = useUpdateManagedHarnessDefaultsMutation()
  const incomingDefaults = realMode ? defaultsFromCatalog(catalogQuery.data) : defaultsQuery.data?.defaults
  const incomingRevision = realMode ? catalogQuery.data?.[0]?.defaultsRevision : 0
  const { draft, setDraft, baseRevision, isDirty, conflicted, acknowledge, reset } = useRevisionedForm<HarnessDefaults>(
    incomingDefaults && incomingRevision !== undefined
      ? { value: { ...incomingDefaults, opencode: { ...incomingDefaults.opencode, autoApprove: false } }, revision: incomingRevision }
      : undefined,
  )
  const [saveError, setSaveError] = useState<string>()
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<{ defaults: HarnessDefaults; expectedRevision: number }>())

  if (realMode ? catalogQuery.isError : defaultsQuery.isError) {
    return (
      <div className="settings-state settings-state-error" role="alert">
        <p>Harness defaults are unavailable.</p>
        <button type="button" onClick={() => void (realMode ? catalogQuery.refetch() : defaultsQuery.refetch())}>Retry</button>
      </div>
    )
  }

  if ((realMode ? catalogQuery.isPending : defaultsQuery.isPending) || !draft) {
    return <p className="settings-state" role="status">Loading harness defaults…</p>
  }

  const save = async () => {
    if (inFlight.current || (conflicted && !attempt.current.unresolved) || baseRevision === undefined) return
    inFlight.current = true
    setSaveError(undefined)
    const submitted = draft
    try {
      if (realMode) {
        const request = attempt.current.input({ defaults: submitted, expectedRevision: baseRevision })
        const response = await managedSaveMutation.mutateAsync({
          ...request, defaults: { ...request.defaults, opencode: { ...request.defaults.opencode, autoApprove: false as const } },
        })
        attempt.current.succeeded()
        acknowledge(submitted, response.value.defaults, response.value.revision)
        queryClient.setQueryData(queryKeys.harnessDefaults, { defaults: response.value.defaults })
        void queryClient.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }).catch(() => undefined)
      } else {
        const response = await saveMutation.mutateAsync({ defaults: submitted })
        acknowledge(submitted, response.defaults, 0)
        queryClient.setQueryData(queryKeys.harnessDefaults, response)
      }
    } catch (error) {
      attempt.current.failed(error)
      setSaveError(error instanceof Error ? error.message : 'Defaults could not be saved.')
    } finally { inFlight.current = false }
  }
  const pending = saveMutation.isPending || managedSaveMutation.isPending
  const uncertain = attempt.current.unresolved && Boolean(saveError)

  return (
    <section className="harness-defaults" aria-labelledby="harness-defaults-title">
      <div className="harness-defaults-heading">
        <div>
          <h2 id="harness-defaults-title">Harness defaults</h2>
          <p>New board agents copy these settings. Existing agents do not change.</p>
        </div>
        <button type="button" onClick={() => void save()} disabled={pending || (conflicted && !uncertain)}>
          {saveMutation.isPending || managedSaveMutation.isPending ? 'Saving…' : 'Save defaults'}
        </button>
      </div>

      {conflicted ? <p className="settings-state-error" role="alert">
        These defaults changed elsewhere. Your edits keep their original revision and will not overwrite that update.
        {!uncertain ? <button type="button" onClick={reset}>Discard edits and load current defaults</button> : null}
      </p> : null}
      {uncertain ? <p role="status">The previous request may have succeeded. Retry Save defaults to resolve that same request.</p> : null}
      <div className="harness-defaults-grid">
        <fieldset disabled={pending || uncertain}>
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
            <option value="danger-full-access">Danger: full access</option>
          </select></div>
          <label className="settings-switch">
            <input type="checkbox" checked={draft.codex.serviceTier === 'priority'} onChange={(event) => setDraft({
              ...draft,
              codex: { ...draft.codex, serviceTier: event.target.checked ? 'priority' : 'standard' },
            })} />
            Fast mode
          </label>
        </fieldset>

        <fieldset disabled={pending || uncertain}>
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

      {(saveMutation.isSuccess || managedSaveMutation.isSuccess) && !isDirty ? <p className="settings-save-status" role="status">Defaults saved.</p> : null}
      {isDirty && !saveMutation.isPending && !managedSaveMutation.isPending ? <p className="settings-save-status" role="status">Unsaved changes.</p> : null}
      {saveError ? <p className="settings-save-status settings-state-error" role="alert">{saveError}</p> : null}
    </section>
  )
}
