import { useState } from 'react'
import type { AgentDefaults } from '@foreman-code/contracts'
import { ErrorState, LoadingState, Switch } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { askOperator } from '../operator-chat/operatorChatStore'
import { SettingsChoice, SettingsOverview } from './SettingsCards'
import { agentRoleOrder, harnessSummary, rolePresentation } from './settingsPresentation'

/** Hiding the chat would also hide the way to ask for it back, so this one setting stays a direct switch. */
function OperatorChatVisibility({ value, revision }: { value: AgentDefaults; revision: number }) {
  const save = useUpdateAgentDefaultsMutation()
  const [commandId, setCommandId] = useState(() => crypto.randomUUID())
  return <>
    <Switch label="Show Operator chat" checked={value.operator.uiEnabled} disabled={save.isPending}
      onChange={(event) => save.mutate({ commandId, expectedRevision: revision,
        value: { ...value, operator: { ...value.operator, uiEnabled: event.target.checked } } },
      { onSuccess: () => setCommandId(crypto.randomUUID()) })} />
    {save.isError ? <small className="operator-mcp-error" role="alert">{save.error.message}</small> : null}
  </>
}

/** Role defaults are summary cards; the Operator agent edits them through MCP. */
export function AgentDefaultsSettings() {
  const query = useAgentDefaultsQuery()
  if (query.isError) return <ErrorState title="Agent defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  if (!query.data) return <LoadingState label="Loading agent defaults…" />
  const { value, revision } = query.data
  return <SettingsOverview title="Agents" description="Defaults for each role. Ask the Operator to change one.">
    {agentRoleOrder.map((role) => {
      const info = rolePresentation[role]
      const summary = [...harnessSummary(value[role].harness), ...(role === 'operator' ? [
        { label: 'Skills', value: String(value.operator.assignedSkills?.length ?? 0) },
        ...(value.operator.harness.harness === 'codex' ? [{ label: 'Thinking', value: value.operator.showThinking ? 'Shown' : 'Hidden' }] : []),
      ] : [])]
      return <SettingsChoice key={role} title={info.title} description={info.description} summary={summary}
        onSelect={() => askOperator(`Change the ${info.title} defaults: `, { send: false })}
        footer={role === 'operator' ? <OperatorChatVisibility value={value} revision={revision} /> : undefined} />
    })}
  </SettingsOverview>
}
