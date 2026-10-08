import { useState, type ReactNode } from 'react'
import { APP_MCP_SERVER_NAMES, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import type { HarnessDefaults } from '@foreman-code/contracts'
import { HarnessDefaultsUpdateInputSchema } from '@foreman-code/contracts/management'
import { useApplyManagedMcpChange, useClaudeSetupOptions, useNativeMcpPlans, useNativeMcpServers } from '../../shared/api/harnessSettings'
import { useUpdateManagedHarnessDefaultsMutation } from '../../shared/api/query'
import { Badge, Button } from '../../shared/ui/nocturne'

type Tone = 'success' | 'warning' | 'neutral'
function Status({ label, tone, children }: { label: string; tone: Tone; children?: ReactNode }) {
  return <>
    <span className="operator-mcp-status"><span>Operator MCP</span><Badge tone={tone}>{label}</Badge></span>
    {children}
  </>
}

/** Codex keeps the Operator MCP in its native user config; one click applies the managed preset. */
function CodexOperatorMcp() {
  const servers = useNativeMcpServers('codex')
  const plans = useNativeMcpPlans('codex')
  const managed = useApplyManagedMcpChange('codex', plans.data?.items)
  const preset = servers.data?.presets?.graphql
  if (servers.isPending) return <Status label="Checking…" tone="neutral" />
  if (servers.isError || !preset) return <Status label="Unavailable" tone="warning">
    <Button size="sm" variant="ghost" onClick={() => void servers.refetch()}>Retry</Button>
  </Status>
  const operation = managed.operation
  if (operation) {
    return <Status label={operation.phase === 'sending' ? 'Installing…' : 'Needs attention'} tone="warning">
      {operation.phase === 'retry' ? <Button size="sm" onClick={managed.retry}>Retry install</Button> : null}
      {operation.phase === 'review' ? <small>Open Connections to review this change.</small> : null}
      {operation.error ? <small className="operator-mcp-error" role="alert">{operation.error}</small> : null}
    </Status>
  }
  const start = (change: { installed: boolean } | { enabled: boolean }) => managed.start({ preset: 'graphql', ...change, expectedRevision: servers.data.revision })
  switch (preset) {
    case 'installed': return <Status label="Installed" tone="success" />
    case 'inherited': return <Status label="Installed" tone="success"><small>From another Codex config layer</small></Status>
    case 'disabled': return <Status label="Disabled" tone="warning"><Button size="sm" onClick={() => start({ enabled: true })}>Enable</Button></Status>
    case 'legacy': case 'mismatch': return <Status label="Outdated" tone="warning"><Button size="sm" onClick={() => start({ installed: true })}>Update</Button></Status>
    default: return <Status label="Not installed" tone="neutral"><Button size="sm" variant="primary" onClick={() => start({ installed: true })}>Install</Button></Status>
  }
}

/** Claude keeps MCP servers in its saved preset; one click adds this app's endpoint to that preset. */
function ClaudeOperatorMcp({ defaults, revision }: { defaults: HarnessDefaults; revision: number }) {
  const setup = useClaudeSetupOptions()
  const save = useUpdateManagedHarnessDefaultsMutation()
  const [commandId] = useState(() => crypto.randomUUID())
  const claude = defaults.claude
  if (!claude) return <Status label="No preset" tone="neutral"><small>Save a Claude preset first</small></Status>
  if (APP_MCP_SERVER_NAMES.some((name) => Object.hasOwn(claude.mcpServers, name))) return <Status label="Installed" tone="success" />
  const endpoint = setup.data?.graphqlMcp
  return <Status label={save.isPending ? 'Installing…' : 'Not installed'} tone="neutral">
    <Button size="sm" variant="primary" disabled={!endpoint || save.isPending} onClick={() => {
      if (!endpoint) return
      save.mutate({ commandId, expectedRevision: revision, defaults: HarnessDefaultsUpdateInputSchema.shape.defaults.parse({
        ...defaults, claude: { ...claude, mcpServers: { ...claude.mcpServers, [PRODUCT_SLUG]: endpoint } } }) })
    }}>Install</Button>
    {save.isError ? <small className="operator-mcp-error" role="alert">{save.error.message}</small> : null}
  </Status>
}

export function OperatorMcpStatus({ harness, defaults, revision }: { harness: 'codex' | 'claude'; defaults: HarnessDefaults; revision: number }) {
  return harness === 'codex' ? <CodexOperatorMcp /> : <ClaudeOperatorMcp defaults={defaults} revision={revision} />
}
