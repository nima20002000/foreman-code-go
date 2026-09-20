import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { CodexPluginChangeInput } from '@graphql/contracts/management'
import { Alert, Button, Dialog, Icon, LoadingState, StatusBadge, TextField } from '../../shared/ui/nocturne'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useChangeCodexPlugin, useCodexPlugin, useCodexPlugins } from '../../shared/api/harnessSettings'
import './codexPlugins.css'

type Draft = Omit<CodexPluginChangeInput, 'commandId'>

export function CodexPluginManager() {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  const view = search.pluginView ?? 'installed'
  const query = search.pluginQuery ?? ''
  const offset = search.pluginOffset ?? 0
  const selectedId = search.pluginId
  const list = useCodexPlugins({ view, query, offset, limit: 24 })
  const detail = useCodexPlugin(selectedId)
  const change = useChangeCodexPlugin()
  const attempt = useRef(new CommandAttempt<Draft>())
  const lastTrigger = useRef<HTMLButtonElement>(null)
  const lastPluginId = useRef<string | undefined>(undefined)
  const wasOpen = useRef(false)
  const searchField = useRef<HTMLInputElement>(null)
  const [pendingInput, setPendingInput] = useState<CodexPluginChangeInput>()
  const [feedback, setFeedback] = useState<string>()
  const [uncertain, setUncertain] = useState(false)
  const move = (fields: Partial<typeof search>) => void navigate({ search: { ...search, ...fields }, replace: true })
  useEffect(() => {
    if (list.data && offset > 0 && offset >= list.data.total) move({ pluginOffset: Math.max(0, Math.floor((list.data.total - 1) / 24) * 24) })
  }, [list.data?.total, offset])
  useEffect(() => {
    if (selectedId) { wasOpen.current = true; return }
    if (!wasOpen.current || !lastPluginId.current) return
    wasOpen.current = false
    const card = lastTrigger.current?.isConnected ? lastTrigger.current
      : [...document.querySelectorAll<HTMLButtonElement>('.codex-plugin-card')].find((item) => item.dataset.pluginId === lastPluginId.current)
    const target = card ?? searchField.current
    target?.focus()
  }, [selectedId])
  const refresh = async () => {
    const result = await list.refetch()
    if (result.isSuccess) {
      attempt.current.succeeded(); setPendingInput(undefined); setUncertain(false); change.reset()
      if (selectedId) void detail.refetch()
    }
  }
  const submit = (input: CodexPluginChangeInput) => {
    setFeedback(undefined)
    change.mutate(input, { onSuccess: (result) => {
      if (result.status === 'uncertain') { setUncertain(true); setPendingInput(input); return }
      attempt.current.succeeded(); setPendingInput(undefined); setUncertain(false)
      setFeedback(result.message)
      if (input.action === 'remove') move({ pluginId: undefined })
      else move({ pluginView: 'installed', pluginQuery: undefined, pluginOffset: 0 })
    }, onError: (error) => { attempt.current.failed(error); setPendingInput(input) } })
  }
  const act = (action: 'install' | 'remove') => {
    if (!detail.data || !list.data || change.isPending || uncertain) return
    const input = attempt.current.input({ pluginId: detail.data.plugin.pluginId, action, expectedRevision: list.data.revision })
    setPendingInput(input)
    submit(input)
  }
  const plugin = detail.data?.plugin
  const busy = change.isPending || uncertain || (change.isError && attempt.current.unresolved)
  return <section className="codex-plugins" aria-label="Codex plugins">
    <p className="harness-muted">Plugins are installed in your Codex profile. New sessions use the updated bundle; service sign-in may still be required.</p>
    <div className="codex-plugins-controls">
      <div className="codex-plugins-tabs" role="group" aria-label="Plugin catalog view">
        <Button size="sm" variant={view === 'installed' ? 'primary' : 'ghost'} aria-pressed={view === 'installed'} onClick={() => move({ pluginView: 'installed', pluginOffset: 0 })}>Installed</Button>
        <Button size="sm" variant={view === 'available' ? 'primary' : 'ghost'} aria-pressed={view === 'available'} onClick={() => move({ pluginView: 'available', pluginOffset: 0 })}>Discover</Button>
      </div>
      <Button size="sm" disabled={list.isFetching} onClick={() => void refresh()}>Refresh</Button>
    </div>
    <TextField ref={searchField} label="Search plugins" type="search" maxLength={100} value={query} placeholder="Name or marketplace" onChange={(event) => move({ pluginQuery: event.target.value || undefined, pluginOffset: 0 })} />
    {change.isError && !selectedId ? <Alert tone="danger" live title="Plugin change could not be confirmed">{change.error.message}
      {pendingInput && attempt.current.unresolved ? <Button size="sm" onClick={() => submit(pendingInput)}>Retry original request</Button> : null}</Alert> : null}
    {uncertain && !selectedId ? <Alert tone="warning" live title="Check the plugin list">The install or removal may have completed. Refresh before making another change.</Alert> : null}
    {feedback && !selectedId ? <p role="status" className="harness-success">{feedback}</p> : null}
    {list.isPending ? <LoadingState label="Loading Codex plugins…" rows={3} /> : null}
    {list.isError ? <Alert tone="danger" title="Codex plugins could not be loaded" action={<Button size="sm" onClick={() => void list.refetch()}>Retry</Button>}>{list.error.message}</Alert> : null}
    {list.data ? <>
      <p className="harness-muted" role="status">{list.data.total} {view === 'installed' ? 'installed' : 'available'} {list.data.total === 1 ? 'plugin' : 'plugins'}{query ? ` matching “${query}”` : ''}</p>
      {list.data.items.length ? <ul className="codex-plugin-grid">{list.data.items.map((item) => <li key={item.pluginId}>
        <button type="button" className="codex-plugin-card" data-plugin-id={item.pluginId} aria-label={`View ${item.name} plugin, ${item.installed ? item.enabled ? 'installed' : 'disabled' : 'available'}`}
          onClick={(event) => { lastTrigger.current = event.currentTarget; lastPluginId.current = item.pluginId; move({ pluginId: item.pluginId }) }}>
          <span className="codex-plugin-icon" aria-hidden="true"><Icon name="spark" size={17} /></span>
          <span className="codex-plugin-identity"><strong>{item.name}</strong><small>{item.marketplaceName}</small></span>
          <span className="codex-plugin-state">{item.installed ? item.enabled ? 'Installed' : 'Disabled' : 'Available'}</span>
        </button>
      </li>)}</ul> : <p className="harness-empty">{query ? 'No plugins match this search.' : view === 'installed' ? 'No plugins are installed in Codex.' : 'No plugins are available from the configured marketplaces.'}</p>}
      {list.data.total > 24 ? <div className="codex-plugins-pages">
        <Button size="sm" disabled={offset === 0 || list.isFetching} onClick={() => move({ pluginOffset: Math.max(0, offset - 24) })}>Previous</Button>
        <span className="harness-muted">{list.data.total ? `${offset + 1}–${Math.min(offset + 24, list.data.total)} of ${list.data.total}` : '0 results'}</span>
        <Button size="sm" disabled={list.data.nextOffset === null || list.isFetching} onClick={() => move({ pluginOffset: list.data?.nextOffset ?? offset })}>Next</Button>
      </div> : null}
    </> : null}
    <Dialog open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) move({ pluginId: undefined }) }} title={plugin ? `${plugin.name} plugin` : 'Plugin details'} size="md"
      closeOnOutsideClick busy={change.isPending}
      footer={<>
        {plugin && !plugin.installed && plugin.installPolicy === 'AVAILABLE' ? <Button variant="primary" disabled={busy || !list.data} onClick={() => act('install')}>Install plugin</Button> : null}
        {plugin?.installed && plugin.installPolicy !== 'INSTALLED_BY_DEFAULT' ? <Button variant="danger" leading={<Icon name="trash" size={16} />}
          disabled={busy || !list.data} onClick={() => act('remove')}>Remove plugin</Button> : null}
        <Button disabled={change.isPending} onClick={() => move({ pluginId: undefined })}>Close</Button>
      </>}>
      {detail.isPending ? <p role="status">Loading plugin details…</p> : null}
      {detail.isError ? <Alert tone="danger" title="Plugin details could not be loaded" action={<Button size="sm" onClick={() => void detail.refetch()}>Retry</Button>}>{detail.error.message}</Alert> : null}
      {change.isError ? <Alert tone="danger" live title="Plugin change could not be confirmed">{change.error.message}
        {pendingInput && attempt.current.unresolved ? <Button size="sm" onClick={() => submit(pendingInput)}>Retry original request</Button>
          : <Button size="sm" onClick={() => void refresh()}>Refresh list</Button>}</Alert> : null}
      {uncertain ? <Alert tone="warning" live title="Check the plugin list">The install or removal may have completed.
        <Button size="sm" onClick={() => void refresh()}>Refresh list</Button></Alert> : null}
      {feedback ? <p role="status" className="harness-success">{feedback}</p> : null}
      {plugin ? <div className="codex-plugin-detail">
        <StatusBadge tone={plugin.installed ? plugin.enabled ? 'success' : 'warning' : 'neutral'} label={plugin.installed ? plugin.enabled ? 'Installed' : 'Disabled' : 'Available'} />
        <dl className="harness-change-details">
          <div><dt>Marketplace</dt><dd>{plugin.marketplaceName}</dd></div>
          <div><dt>Version</dt><dd>{plugin.version ?? 'Not listed'}</dd></div>
          <div><dt>Sign-in</dt><dd>{plugin.authPolicy === 'ON_INSTALL' ? 'May be required during installation' : 'May be required when used'}</dd></div>
        </dl>
        {detail.data?.contents.status === 'known' ? <div className="codex-plugin-includes">
          <div><strong>Skills</strong><span>{detail.data.contents.skills.length ? detail.data.contents.skills.join(', ') : 'None included'}</span></div>
          <div><strong>MCP servers</strong><span>{detail.data.contents.mcpServers.length ? detail.data.contents.mcpServers.join(', ') : 'None included'}</span></div>
          <div><strong>Apps</strong><span>{detail.data.contents.apps.length ? detail.data.contents.apps.join(', ') : 'None included'}</span></div>
          <div><strong>Hooks</strong><span>{detail.data.contents.hooks.length ? detail.data.contents.hooks.join(', ') : 'None included'}</span></div>
        </div> : <Alert tone="warning" title="Bundle contents unavailable">Codex has not provided verified skills, hooks, or MCP details for this plugin. Installing it may add these capabilities.</Alert>}
        {plugin.installed && plugin.installPolicy === 'INSTALLED_BY_DEFAULT' ? <p className="harness-muted">Codex installed this plugin by default; it cannot be removed here.</p> : null}
        <p className="harness-muted">Removing a plugin removes its bundled capabilities. Separately configured MCP connections remain in MCP connections.</p>
      </div> : null}
    </Dialog>
  </section>
}
