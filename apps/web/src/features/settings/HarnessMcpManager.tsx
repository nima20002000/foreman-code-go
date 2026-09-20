import { UnsavedChangesContext, useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useContext, useRef, useState } from 'react'
import {
  HarnessMcpChangeSchema, type HarnessMcpChange, type HarnessMcpPlan, type HarnessMcpManagedPreset, type HarnessMcpManagedInput,
} from '@graphql/contracts/management'
import { Alert, Button, Dialog, Icon, Select, StatusBadge, Textarea, TextField } from '../../shared/ui/nocturne'
import {
  useNativeMcpServers, useNativeMcpPlans, useRequestNativeMcpChange, useDecideNativeMcpChange, useApplyManagedMcpChange, useHarnessSessionEpoch,
} from '../../shared/api/harnessSettings'
import { CommandAttempt } from '../../shared/api/commandAttempt'

type Harness = 'codex' | 'opencode'
const words = { add: 'Add', remove: 'Remove', enable: 'Update' }
function ChangeDetails({ change }: { change: HarnessMcpChange }) {
  return <dl className="harness-change-details"><div><dt>Server</dt><dd>{change.name}</dd></div>
    <div><dt>Change</dt><dd>{change.kind === 'enable' ? change.enabled ? 'Enable' : 'Disable' : words[change.kind]}</dd></div>
    {change.kind === 'add' ? change.connection.transport === 'remote' ? <>
      <div><dt>Endpoint</dt><dd>{change.connection.url}</dd></div>
      <div><dt>Authentication</dt><dd>{change.connection.bearerTokenEnvironmentVariable ? `Bearer token from ${change.connection.bearerTokenEnvironmentVariable}` : 'Native authentication'}</dd></div>
    </> : <>
      <div><dt>Executable</dt><dd>{change.connection.executable}</dd></div>
      <div><dt>Arguments</dt><dd>{change.connection.arguments.length ? <ol>{change.connection.arguments.map((argument, index) => <li key={index}><code>{argument || '(empty argument)'}</code></li>)}</ol> : 'None'}</dd></div>
      <div><dt>Environment references</dt><dd>{change.connection.environmentVariables.join(', ') || 'None added'}</dd></div>
    </> : null}
  </dl>
}
function ConnectionForm({ busy, onReview }: { busy: boolean; onReview(change: HarnessMcpChange): void }) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'remote' | 'stdio'>('remote')
  const [url, setUrl] = useState('')
  const [variable, setVariable] = useState('')
  const [executable, setExecutable] = useState('')
  const [argumentsText, setArgumentsText] = useState('')
  const [environment, setEnvironment] = useState('')
  const [error, setError] = useState<string>()
  const review = () => {
    const candidate = HarnessMcpChangeSchema.safeParse({ kind: 'add', name: name.trim(), connection: transport === 'remote'
      ? { transport, url: url.trim(), ...(variable.trim() ? { bearerTokenEnvironmentVariable: variable.trim() } : {}) }
      : { transport, executable: executable.trim(), arguments: argumentsText === '' ? [] : argumentsText.split('\n'),
        environmentVariables: environment.split(/[,\s]+/).filter(Boolean) } })
    if (!candidate.success) { setError(candidate.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' ')); return }
    setError(undefined)
    onReview(candidate.data)
  }
  useUnsavedChanges({ scope: 'surface', label: 'new MCP connection',
    dirty: Boolean(name || url || variable || executable || argumentsText || environment || transport !== 'remote'),
    busy, saveDisabled: true, error: 'Keep editing and use Review connection to review this change before applying it.',
    save: review, discard: () => {
      setName(''); setUrl(''); setVariable(''); setExecutable(''); setArgumentsText(''); setEnvironment(''); setTransport('remote'); setError(undefined)
    },
  })
  return <div className="harness-form-stack">
    <TextField label="Server name" value={name} maxLength={80} autoComplete="off" onChange={(event) => setName(event.target.value)} />
    <Select label="Connection" value={transport} options={[{ value: 'remote', label: 'Remote · URL' }, { value: 'stdio', label: 'Local · installed program' }]}
      onChange={(event) => setTransport(event.target.value as typeof transport)} />
    {transport === 'remote' ? <>
      <TextField label="Server URL" type="url" placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />
      <TextField label="Token environment variable (optional)" placeholder="MY_SERVICE_TOKEN" autoComplete="off" spellCheck={false} value={variable}
        hint="Enter the variable name, not the token." onChange={(event) => setVariable(event.target.value)} />
    </> : <>
      <TextField label="Installed executable" value={executable} placeholder="/absolute/path/to/mcp-server" autoComplete="off" onChange={(event) => setExecutable(event.target.value)} />
      <Textarea label="Arguments · one per line" rows={3} value={argumentsText} spellCheck={false} onChange={(event) => setArgumentsText(event.target.value)} />
      <TextField label="Environment variable names (optional)" value={environment} autoComplete="off" placeholder="SERVICE_TOKEN, SERVICE_ACCOUNT" onChange={(event) => setEnvironment(event.target.value)} />
    </>}
    {error ? <Alert tone="danger" live title={error} /> : null}
    <Button variant="primary" disabled={busy} onClick={review}>Review connection</Button>
  </div>
}

function NativeMcpManager({ harness }: { harness: Harness }) {
  const guard = useContext(UnsavedChangesContext)
  const servers = useNativeMcpServers(harness)
  const plans = useNativeMcpPlans(harness)
  const request = useRequestNativeMcpChange()
  const decision = useDecideNativeMcpChange()
  const managed = useApplyManagedMcpChange()
  const managedAttempt = useRef(new CommandAttempt<Omit<HarnessMcpManagedInput, 'commandId'>>())
  const [managedInput, setManagedInput] = useState<HarnessMcpManagedInput>()
  const [adding, setAdding] = useState(false)
  const [active, setActive] = useState<string>()
  const [detailsName, setDetailsName] = useState<string>()
  const [created, setCreated] = useState<HarnessMcpPlan>()
  const [feedback, setFeedback] = useState<string>()
  // A failed HTTP response may hide a committed plan. Reuse the same receipt ID on retry.
  const command = useRef<{ signature: string; id: string } | undefined>(undefined)
  const selected = decision.data?.id === active ? decision.data : plans.data?.items.find((plan) => plan.id === active) ?? (created?.id === active ? created : undefined)
  const expired = Boolean(selected && Date.parse(selected.expiresAt) <= Date.now())
  const requestChange = (change: HarnessMcpChange) => {
    if (!servers.data || request.isPending) return
    const signature = JSON.stringify([harness, servers.data.revision, change])
    if (command.current?.signature !== signature) command.current = { signature, id: crypto.randomUUID() }
    setFeedback(undefined)
    decision.reset()
    request.mutate({ harness, commandId: command.current.id, expectedRevision: servers.data.revision, change }, {
      onSuccess: (result) => { setCreated(result.value); setActive(result.value.id); setAdding(false) },
    })
  }
  const decide = (approve: boolean) => {
    if (!selected || selected.status !== 'pending') return
    decision.mutate({ planId: selected.id, approve }, { onSuccess: (result) => {
      setCreated(result)
      if (result.status === 'applied') { setFeedback('Connection settings saved. New sessions will use them.'); setActive(undefined) }
      if (result.status === 'rejected') setActive(undefined)
    } })
  }
  const submitManaged = (input: HarnessMcpManagedInput) => {
    setFeedback(undefined)
    managed.mutate(input, { onSuccess: (result) => {
      managedAttempt.current.succeeded()
      setManagedInput(undefined)
      setCreated(result)
      if (result.status === 'applied') {
        if (!input.installed) setDetailsName(undefined)
        setFeedback(`${input.preset === 'operator' ? 'Operator MCP' : 'Linear MCP'} ${input.installed ? 'added to' : 'removed from'} ${harness === 'codex' ? 'Codex' : 'OpenCode'}. New sessions use the updated connections.`)
      }
    }, onError: (error) => { managedAttempt.current.failed(error) } })
  }
  const manage = (preset: HarnessMcpManagedPreset, installed: boolean) => {
    if (!servers.data || managed.isPending) return
    const input = managedAttempt.current.input({ harness, preset, installed, expectedRevision: servers.data.revision })
    setManagedInput(input)
    submitManaged(input)
  }
  const retryManaged = () => {
    if (!managedInput || managed.isPending) return
    submitManaged(managedInput)
  }
  const presets = servers.data?.presets
  const details = servers.data?.servers.find((server) => server.name === detailsName)
  const detailsPreset = details?.name === 'graphql-operator' && presets?.operator === 'installed' ? 'operator'
    : details?.name === 'linear' && presets?.linear === 'installed' ? 'linear' : undefined
  const detailsRemovable = Boolean(details && (detailsPreset || details.editable))
  const outstanding = plans.data?.items.filter((plan) => ['pending', 'submitting', 'uncertain'].includes(plan.status)) ?? []
  const managedBusy = managed.isPending || Boolean(managedInput && managed.isError && managedAttempt.current.unresolved)
    || outstanding.some((plan) => plan.status === 'submitting' || plan.status === 'uncertain')
  const detailsBusy = managedBusy || request.isPending || decision.isPending || servers.isFetching || servers.isError
  return <section className="harness-mcp-manager" aria-label={`${harness} MCP connections`}>
    <div className="harness-section-heading"><div><h4>MCP servers</h4><p className="harness-muted">Native user configuration · changes apply to new sessions.</p></div>
      <div className="harness-inline-actions"><Button size="sm" disabled={servers.isFetching} onClick={() => void servers.refetch()}>Refresh</Button>
        <Button size="sm" variant="primary" disabled={!servers.data || servers.isError} onClick={() => { request.reset(); setAdding(true) }}>Add server</Button></div></div>
    {servers.isPending ? <p role="status">Reading configured servers…</p> : null}
    {servers.isError ? <Alert tone="danger" title={servers.error.message} /> : null}
    {request.isError ? <Alert live tone="danger" title={request.error.message} /> : null}
    {managed.isError ? <Alert live tone="danger" title={managedAttempt.current.unresolved ? 'MCP change could not be confirmed' : 'MCP change was not applied'}>{managed.error.message}
      {managedInput && managedAttempt.current.unresolved ? <Button size="sm" onClick={retryManaged}>Retry original change</Button> : null}</Alert> : null}
    {managed.data?.status === 'uncertain' ? <Alert live tone="warning" title="MCP change needs inspection">The native write may have succeeded. Refresh the server list before making another change.</Alert> : null}
    {feedback ? <p role="status" className="harness-success">{feedback}</p> : null}
    {presets ? <div className="harness-preset-actions" aria-label="Suggested MCP servers">
      {(['operator', 'linear'] as const).map((preset) => {
        const status = presets[preset]
        if (status === 'installed') return null
        const label = preset === 'operator' ? 'Operator MCP' : 'Linear MCP'
        return <div key={preset} className="harness-preset-row"><div><strong>{label}</strong>
          <small>{status === 'missing' ? preset === 'operator' ? 'Local app tools for Operator chat.' : 'Read-only Linear connection; sign in with the harness after adding.'
            : status === 'inherited' ? 'Configured outside this user profile. Edit it at its source.'
              : preset === 'operator' ? 'Replace this mismatched entry with the app’s Operator MCP connection.' : 'Existing configuration differs from this preset. Inspect it before changing.'}</small></div>
          {status === 'missing' || (preset === 'operator' && status === 'mismatch') ? <Button size="sm" disabled={managedBusy || servers.isFetching || servers.isError} loading={managed.isPending && managed.variables?.preset === preset}
            onClick={() => manage(preset, true)}>{status === 'mismatch' ? 'Repair' : 'Add'} {label}</Button> : <StatusBadge tone="warning" label={status === 'inherited' ? 'Inherited' : 'Needs attention'} />}
        </div>
      })}
    </div> : null}
    {servers.data?.servers.length === 0 ? <div className="harness-empty">No servers configured. Add a connection to give this harness more tools.</div> : null}
    <ul className="harness-server-list">{servers.data?.servers.map((server) => {
      const status = !server.enabled ? 'Disabled'
        : server.origin === 'inherited' ? 'Inherited'
          : (server.name === 'graphql-operator' && presets?.operator === 'mismatch') || (server.name === 'linear' && presets?.linear === 'mismatch') ? 'Needs attention' : 'Enabled'
      return <li key={server.name}>
        <button type="button" className="harness-server-open" aria-label={`View details for ${server.name}, ${status}`} onClick={() => setDetailsName(server.name)}>
          <span className="harness-server-symbol" aria-hidden="true">{server.transport === 'remote' ? '↗' : '⌘'}</span>
          <span className="harness-server-name"><strong>{server.name}</strong></span>
          <span className="harness-server-status" data-status={status === 'Enabled' ? 'enabled' : status === 'Disabled' ? 'disabled' : 'attention'} aria-hidden="true" />
        </button>
      </li>
    })}</ul>
    {outstanding.length ? <section className="harness-pending-plans" aria-label="MCP change requests"><h4>Change requests</h4>
      {outstanding.map((plan) => {
        const applying = managed.isPending && plan.managedPreset === managed.variables?.preset
          && plan.change.kind === (managed.variables?.installed ? 'add' : 'remove')
        return <div key={plan.id} className="harness-plan-row"><span>{words[plan.change.kind]} <strong>{plan.change.name}</strong><small>{applying ? 'Awaiting native confirmation' : plan.status === 'pending' && Date.parse(plan.expiresAt) <= Date.now() ? 'Expired' : plan.status}</small></span>
          {applying ? <span role="status">Applying…</span> : <Button size="sm" onClick={() => { decision.reset(); setActive(plan.id) }}>Review</Button>}</div>
      })}
    </section> : null}
    {plans.isError ? <p className="harness-muted" role="status">Change requests: {plans.error.message}</p> : null}
    <Dialog open={adding} onOpenChange={(open) => { if (open) setAdding(true); else void (async () => { if (!guard || await guard.surfaces()) setAdding(false) })() }} title={`Add ${harness === 'codex' ? 'Codex' : 'OpenCode'} MCP server`} size="md" busy={request.isPending}>
      {adding ? <ConnectionForm busy={request.isPending} onReview={requestChange} /> : null}
      {request.isError ? <Alert tone="danger" title={request.error.message} /> : null}
    </Dialog>
    <Dialog open={Boolean(active)} onOpenChange={(open) => { if (!open) setActive(undefined) }} title="Review MCP change" size="md" busy={decision.isPending}
      footer={selected?.status === 'pending' && !expired ? <><Button disabled={decision.isPending} onClick={() => decide(false)}>Reject</Button>
        <Button variant={selected.change.kind === 'remove' ? 'danger' : 'primary'} disabled={decision.isPending} onClick={() => decide(true)}>{decision.isPending ? 'Applying…' : 'Approve and apply'}</Button></> : <Button onClick={() => setActive(undefined)}>Close</Button>}>
      {selected ? <div className="harness-form-stack"><p>{selected.harness === 'codex' ? 'Codex' : 'OpenCode'} · native user configuration</p><ChangeDetails change={selected.change} />
        <p className="harness-access-warning">A server may run programs or send data to its endpoint. Only approve a connection you trust.</p>
        <span className="harness-muted">Requested by {selected.requestedBy}</span>
        {selected.status !== 'pending' || expired ? <Alert tone={selected.status === 'applied' ? 'success' : 'warning'} title={expired && selected.status === 'pending' ? 'Request expired. Create a new request.' : `Change ${selected.status}`}>
          {selected.error ?? (selected.status === 'uncertain' ? 'The write may have completed. Inspect the native configuration before requesting another change.' : null)}</Alert> : null}
        {decision.isError ? <Alert tone="danger" live title={decision.error.message} /> : null}
      </div> : <p role="status">Loading request…</p>}
    </Dialog>
    <Dialog open={Boolean(detailsName)} onOpenChange={(open) => { if (!open) setDetailsName(undefined) }}
      title={details ? `${details.name} MCP details` : 'MCP server unavailable'} size="md" closeOnOutsideClick busy={managed.isPending}
      footer={<>
        {details?.editable ? <Button disabled={detailsBusy} onClick={() => {
          setDetailsName(undefined)
          requestChange({ kind: 'enable', name: details.name, enabled: !details.enabled })
        }}>{details.enabled ? 'Disable' : 'Enable'}</Button> : null}
        {details ? <Button variant="danger" leading={<Icon name="trash" size={16} />} disabled={!detailsRemovable || detailsBusy} onClick={() => {
          if (detailsPreset) manage(detailsPreset, false)
          else { setDetailsName(undefined); requestChange({ kind: 'remove', name: details.name }) }
        }}>Remove server</Button> : null}
        <Button onClick={() => setDetailsName(undefined)}>Close</Button>
      </>}>
      {details ? <div className="harness-form-stack">
        <StatusBadge tone={!details.enabled ? 'danger' : details.origin === 'inherited' || (details.name === 'graphql-operator' && presets?.operator === 'mismatch') || (details.name === 'linear' && presets?.linear === 'mismatch') ? 'warning' : 'success'}
          label={!details.enabled ? 'Disabled' : details.origin === 'inherited' ? 'Inherited' : (details.name === 'graphql-operator' && presets?.operator === 'mismatch') || (details.name === 'linear' && presets?.linear === 'mismatch') ? 'Needs attention' : 'Enabled'} />
        <dl className="harness-change-details">
          <div><dt>Harness</dt><dd>{harness === 'codex' ? 'Codex' : 'OpenCode'}</dd></div>
          <div><dt>Native name</dt><dd><code>{details.name}</code></dd></div>
          <div><dt>Connection</dt><dd>{details.transport === 'remote' ? 'Remote MCP' : details.transport === 'stdio' ? 'Local program' : 'Native connection'}</dd></div>
          <div><dt>{details.transport === 'remote' ? 'Host' : 'Program'}</dt><dd>{details.label}</dd></div>
          {details.endpoint ? <div><dt>Endpoint</dt><dd><code>{details.endpoint}</code></dd></div> : null}
          <div><dt>Configuration</dt><dd>{details.origin === 'inherited' ? 'Inherited from another configuration source' : details.protected ? 'App-managed user configuration' : 'Native user configuration'}</dd></div>
        </dl>
        {details.transport === 'remote' && !details.endpoint ? <p className="harness-muted">Only the host is shown here. Native URLs can contain private credentials; inspect their configuration source for the full address.</p> : null}
        <p className="harness-muted">Enabled means the native configuration permits startup; a live tool call is needed to verify the connection.</p>
        {!detailsRemovable ? <p className="harness-muted">{details.protected ? 'App-managed connection cannot be removed here.' : 'Edit this inherited connection at its source.'}</p> : null}
        {details.name === 'linear' && presets?.linear === 'installed' ? <p className="harness-muted">
          Sign in with <code>{harness === 'codex' ? 'codex mcp login linear' : 'opencode mcp auth linear'}</code>. Removing this connection keeps the harness’s saved sign-in.
        </p> : null}
      </div> : <p role="status">This server is no longer in the native list. Refresh to see current connections.</p>}
    </Dialog>
  </section>
}

export function HarnessMcpManager({ harness }: { harness: Harness }) {
  const epoch = useHarnessSessionEpoch()
  return <NativeMcpManager key={`${harness}:${epoch}`} harness={harness} />
}
