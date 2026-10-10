import type { AgentHarness, HarnessDefaults } from '@foreman-code/contracts'
import type { HarnessSettingsSection } from '@foreman-code/contracts/management'
import { Button, Dialog, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { useManagedHarnessCatalogQuery } from '../../shared/api/query'
import { askOperator } from '../operator-chat/operatorChatStore'
import { SettingsChoice, SettingsOverview } from './SettingsCards'
import { harnessNames, harnessSummary } from './settingsPresentation'
import { ClaudePluginSummary } from './ClaudePluginSummary'
import { CodexPluginManager } from './CodexPluginManager'
import { HarnessMcpManager } from './HarnessMcpManager'
import { OperatorMcpStatus } from './OperatorMcpStatus'
import { ProviderAccountsSettings } from '../provider-accounts/ProviderAccountsSettings'

/** Harnesses this app runs: Codex and Claude. */
const HARNESSES = ['codex', 'claude'] as const
type Harness = typeof HARNESSES[number]

function useProviderDefaults() {
  const catalogQuery = useManagedHarnessCatalogQuery(true)
  const codex = catalogQuery.data?.find((entry) => entry.harness === 'codex')
  const claude = catalogQuery.data?.find((entry) => entry.harness === 'claude')
  const incoming = codex?.defaults.harness === 'codex' && (!claude || (claude.defaults.harness === 'claude' && claude.defaultsRevision === codex.defaultsRevision))
    ? { value: { codex: codex.defaults, ...(claude?.defaults.harness === 'claude' ? { claude: claude.defaults } : {}) } as HarnessDefaults, revision: codex.defaultsRevision }
    : undefined
  return { incoming, query: catalogQuery }
}

function ProviderCard({ harness, value, revision, readiness, onOpen }: {
  harness: Harness; value: HarnessDefaults; revision: number; readiness: string
  onOpen(section: 'connections' | 'plugins'): void
}) {
  const name = harnessNames[harness]
  const preset = value[harness]
  const summary = [...(preset ? harnessSummary(preset).filter((item) => item.label !== 'Harness') : [{ label: 'Preset', value: 'Not configured' }]),
    { label: 'Status', value: readiness }]
  return <SettingsChoice icon="settings" title={name} summary={summary}
    description={harness === 'codex' ? 'Native app-server' : 'Host-local Claude profile'}
    onSelect={() => askOperator(`Change the ${name} preset: `, { send: false })}
    footer={<>
      <OperatorMcpStatus harness={harness} defaults={value} revision={revision} />
      <span className="settings-choice-links">
        {harness === 'codex' ? <>
          <Button size="sm" variant="ghost" onClick={() => onOpen('connections')}>Connections</Button>
        </> : null}
        <Button size="sm" variant="ghost" onClick={() => onOpen('plugins')}>Plugins</Button>
      </span>
    </>} />
}

/** Harness presets and plugin changes are managed by the Operator. */
export function HarnessDefaultsSettings({ selectedHarness, section, onOpen }: {
  selectedHarness?: AgentHarness | undefined; section?: HarnessSettingsSection | undefined
  onOpen?(next: { harness: Harness; section: 'connections' | 'plugins' } | undefined): void
}) {
  const { incoming, query } = useProviderDefaults()
  let dialog: 'plugins' | 'connections' | undefined
  if (section === 'plugins' && (selectedHarness === 'codex' || selectedHarness === 'claude')) dialog = 'plugins'
  if (section === 'connections' && selectedHarness === 'codex') dialog = 'connections'
  const dialogName = selectedHarness === 'claude' ? 'Claude' : 'Codex'
  if (query.isError || (query.isSuccess && !incoming)) return <ErrorState title="Harness defaults are unavailable"
    description={query.error?.message ?? 'The server returned an incomplete provider catalog.'} onRetry={() => void query.refetch()} />
  if (!incoming) return <LoadingState label="Loading harness defaults…" />
  const readiness = (harness: Harness) => {
    const entry = query.data?.find((item) => item.harness === harness)
    return !entry ? 'Not configured' : entry.discoveryError ? entry.discoveryError.message : entry.capability ? 'Ready' : 'Checking…'
  }
  return <>
    <SettingsOverview title="Harnesses" description="Your harness presets. Ask the Operator to change one.">
      {HARNESSES.map((harness) => <ProviderCard key={harness} harness={harness} value={incoming.value} revision={incoming.revision}
        readiness={readiness(harness)} onOpen={(next) => onOpen?.({ harness, section: next })} />)}
    </SettingsOverview>
    <ProviderAccountsSettings />
    <Dialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) onOpen?.(undefined) }} size="lg"
      title={dialog === 'plugins' ? `${dialogName} plugins` : 'Codex connections'}
      description={dialog === 'plugins' ? `Plugins add skills, hooks and tools to ${dialogName}. Ask the Operator to manage them.`
        : 'Native MCP connections. Changes the Operator prepares wait here for your approval.'}>
      {dialog === 'plugins' && selectedHarness === 'claude' ? <ClaudePluginSummary onClose={() => onOpen?.(undefined)} /> : null}
      {dialog === 'plugins' && selectedHarness === 'codex' ? <CodexPluginManager /> : null}
      {dialog === 'connections' ? <HarnessMcpManager harness="codex" /> : null}
    </Dialog>
  </>
}
