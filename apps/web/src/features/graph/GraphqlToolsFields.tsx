import {
  GRAPHQL_AGENT_TOOLS, effectiveGraphqlTools, graphqlRoleTools,
  type GraphqlAgentTool, type GraphqlToolOverride,
} from '@foreman-code/contracts'

import { Checkbox, SegmentedControl } from '../../shared/ui/nocturne'

type NodeChoice = 'default' | 'on' | 'off'

/** An empty override is stored as none, so the node follows the Agent default. */
function normalizeToolOverride(override: GraphqlToolOverride | undefined): GraphqlToolOverride | undefined {
  return override && (override.add.length || override.remove.length) ? override : undefined
}

/** The Agent's default Foreman Code MCP tools, and this workflow node's change to them. */
export function GraphqlToolsFields({ role, defaults, override, onChange }: {
  /** Workflow Agent roles only; Operator tools are never enabled per Agent. */
  role: 'orchestrator' | 'coder'
  defaults: readonly GraphqlAgentTool[] | undefined
  override: GraphqlToolOverride | undefined
  /** defaults stays undefined (inherit every role tool) until the Agent default itself is edited. */
  onChange(defaults: GraphqlAgentTool[] | undefined, override: GraphqlToolOverride | undefined): void
}) {
  const tools = graphqlRoleTools(role)
  const agentDefault = defaults ? tools.filter((tool) => defaults.includes(tool)) : tools
  const choice = (tool: GraphqlAgentTool): NodeChoice => override?.add.includes(tool) ? 'on' : override?.remove.includes(tool) ? 'off' : 'default'
  const setDefault = (tool: GraphqlAgentTool, enabled: boolean) => {
    const next = tools.filter((item) => item === tool ? enabled : agentDefault.includes(item))
    // A node change that now matches the default is no longer a change.
    const add = (override?.add ?? []).filter((item) => !next.includes(item))
    const remove = (override?.remove ?? []).filter((item) => next.includes(item))
    onChange(next, normalizeToolOverride({ add, remove }))
  }
  const setChoice = (tool: GraphqlAgentTool, value: NodeChoice) => {
    const add = (override?.add ?? []).filter((item) => item !== tool)
    const remove = (override?.remove ?? []).filter((item) => item !== tool)
    if (value === 'on' && !agentDefault.includes(tool)) add.push(tool)
    if (value === 'off' && agentDefault.includes(tool)) remove.push(tool)
    // A node-only change never rewrites the Agent's default.
    onChange(defaults ? [...defaults] : undefined, normalizeToolOverride({ add, remove }))
  }
  const effective = effectiveGraphqlTools(role, agentDefault, override)
  return <fieldset className="agent-graphql-tools">
    <legend>Foreman Code MCP tools</legend>
    <p className="settings-help">
      Bug reporting is always available. For other tools, the Agent default applies in every workflow.
      This workflow can turn a tool on or off for this node only.
    </p>
    <div className="agent-graphql-tools-list">
      {tools.map((tool) => {
        const definition = GRAPHQL_AGENT_TOOLS[tool]
        if (tool === 'bug_report') {
          return <div key={tool} className="agent-graphql-tool">
            <div className="agent-graphql-tool-name">
              <strong>{definition.label}</strong>
              <span><code>{tool}</code> · {definition.description}</span>
            </div>
            <span>Always available</span>
          </div>
        }
        const inDefault = agentDefault.includes(tool)
        return <div key={tool} className="agent-graphql-tool" data-changed={choice(tool) !== 'default' || undefined}>
          <div className="agent-graphql-tool-name">
            <strong>{definition.label}</strong>
            <span><code>{tool}</code> · {definition.description}</span>
          </div>
          <Checkbox label="Agent default" aria-label={`${definition.label}: Agent default`} checked={inDefault}
            onChange={(event) => setDefault(tool, event.target.checked)} />
          <SegmentedControl label={`${definition.label}: this workflow`} value={choice(tool)} onValueChange={(value) => setChoice(tool, value as NodeChoice)}
            options={[{ value: 'default', label: `Default (${inDefault ? 'on' : 'off'})` }, { value: 'on', label: 'On', disabled: inDefault }, { value: 'off', label: 'Off', disabled: !inDefault }]} />
        </div>
      })}
    </div>
    <p className="settings-help" aria-live="polite">Enabled in this workflow: {effective.length ? effective.map((tool) => GRAPHQL_AGENT_TOOLS[tool].label).join(', ') : 'none'}.</p>
  </fieldset>
}
