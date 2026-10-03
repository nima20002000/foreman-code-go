import { useState } from 'react'
import { ClaudeMcpServerNameSchema, ClaudeMcpServerSchema, type ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { useClaudeSetupOptions } from '../../shared/api/harnessSettings'
import { Alert, Button, TextField } from '../../shared/ui/nocturne'

/** Edits only the parent configuration draft; its revisioned save owns persistence. */
export function ClaudeMcpConfiguration({ value, onChange, appPreset = true }: {
  value: ClaudeHarnessConfiguration; onChange(value: ClaudeHarnessConfiguration): void; appPreset?: boolean;
}) {
  const setup = useClaudeSetupOptions(appPreset)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string>()
  const setServer = (serverName: string, server: ClaudeHarnessConfiguration['mcpServers'][string]) =>
    onChange({ ...value, mcpServers: { ...value.mcpServers, [serverName]: server } })
  const add = () => {
    const parsedName = ClaudeMcpServerNameSchema.safeParse(name.trim())
    const parsedServer = ClaudeMcpServerSchema.safeParse({ type: 'http', url: url.trim() })
    if (!parsedName.success) { setError('Use a server name beginning with a letter, with letters, numbers, underscores or hyphens.'); return }
    if (Object.hasOwn(value.mcpServers, parsedName.data)) { setError('This server name is already configured. Remove it before replacing it.'); return }
    if (!parsedServer.success) { setError('Use HTTPS or a local HTTP endpoint without credentials, a query or a fragment.'); return }
    setServer(parsedName.data, parsedServer.data)
    setName(''); setUrl(''); setError(undefined)
  }
  return <section className="harness-form-stack" aria-label="Claude MCP configuration">
    <p>MCP connections are saved in this configuration and supplied directly to Claude. Save your changes below to apply them to future configurations. Existing agents and sessions keep their pins.</p>
    {appPreset ? <div className="harness-section-heading"><div><strong>GraphQL MCP</strong><p className="harness-muted">The app delivers a scoped credential at authorized execution. Adding this connection does not grant tool access or qualify Claude.</p></div>
      <Button size="sm" disabled={!setup.data?.graphqlMcp || Object.hasOwn(value.mcpServers, 'graphql')}
        onClick={() => { if (setup.data?.graphqlMcp) setServer('graphql', setup.data.graphqlMcp) }}>{value.mcpServers.graphql ? 'GraphQL added' : 'Add GraphQL MCP'}</Button>
    </div> : null}
    {appPreset && setup.isError ? <Alert tone="warning" title="Could not read the app MCP endpoint" action={<Button size="sm" onClick={() => void setup.refetch()}>Retry</Button>}>{setup.error.message}</Alert> : null}
    {Object.entries(value.mcpServers).map(([serverName, server]) => <div key={serverName} className="harness-policy-row">
      <div className="harness-section-heading"><strong>{serverName}</strong><Button size="sm" variant="ghost" onClick={() => {
        const next = { ...value.mcpServers }; delete next[serverName]; onChange({ ...value, mcpServers: next })
      }}>Remove {serverName}</Button></div><p><code>{server.url}</code></p>
    </div>)}
    {!Object.keys(value.mcpServers).length ? <p className="harness-muted">No MCP servers are configured.</p> : null}
    <div className="harness-two-columns"><TextField label="MCP server name" value={name} onChange={event => setName(event.target.value)} />
      <TextField label="MCP endpoint" value={url} placeholder="https://example.com/mcp" onChange={event => setUrl(event.target.value)} /></div>
    {error ? <p role="alert" className="n-field-error">{error}</p> : null}
    <Button size="sm" disabled={!name.trim() || !url.trim()} onClick={add}>Add HTTP MCP server</Button>
    <p className="harness-muted">HTTP connections are supported. Native CLI connections, package installers and ambient configuration are excluded from this accepted profile.</p>
  </section>
}
