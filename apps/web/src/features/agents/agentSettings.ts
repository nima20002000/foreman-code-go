import {
  DEFAULT_HARNESS_DEFAULTS,
  AgentEffortSchema,
  type Agent,
  type HarnessConfiguration,
  type HarnessDefaults,
  type AgentProductRole,
} from '@graphql/contracts'

export const STANDARD_EFFORTS: readonly NonNullable<Agent['effort']>[] = [
  'low', 'medium', 'high', 'xhigh', 'max',
]

export function initialModel(agent: Agent, harness: NonNullable<Agent['harness']>): string {
  return (agent.harnessConfiguration?.harness === harness ? agent.harnessConfiguration.model
    : agent.harness === harness ? agent.model : undefined) ?? DEFAULT_HARNESS_DEFAULTS[harness].model
}

export function effortOptions(
  harness: NonNullable<Agent['harness']>,
  model: string,
): readonly NonNullable<Agent['effort']>[] {
  if (harness === 'opencode') return ['low', 'high', 'max']
  return model === 'gpt-6-astra' ? [...STANDARD_EFFORTS, 'ultra'] : STANDARD_EFFORTS
}

export const effortLabels: Record<NonNullable<Agent['effort']>, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

export function configuredHarness(
  agent: Agent,
  harness: NonNullable<Agent['harness']>,
  model: string,
  effort: string,
  fastMode: boolean,
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access',
  creationDefaults?: HarnessDefaults,
): HarnessConfiguration {
  // New agents use the selected global template; existing agents keep their
  // copied settings and must not inherit later global-default changes.
  const current = creationDefaults?.[harness]
    ?? (agent.harnessConfiguration?.harness === harness
      ? agent.harnessConfiguration
      : DEFAULT_HARNESS_DEFAULTS[harness])
  if (harness === 'opencode') {
    const opencode = current.harness === 'opencode' ? current : DEFAULT_HARNESS_DEFAULTS.opencode
    return {
      ...opencode,
      model,
      // A custom provider variant cannot be represented by the legacy effort control.
      variant: !['low', 'high', 'max'].includes(opencode.variant) ? opencode.variant
        : effort === 'low' || effort === 'high' || effort === 'max' ? effort : opencode.variant,
    }
  }
  const codex = current.harness === 'codex' ? current : DEFAULT_HARNESS_DEFAULTS.codex
  return {
    ...codex,
    model,
    reasoningEffort: AgentEffortSchema.parse(effort),
    sandbox,
    serviceTier: fastMode ? 'priority' : 'standard',
  }
}

export function defaultAgentForHarness(
  harness: NonNullable<Agent['harness']>,
  id: string,
  name: string,
  configuration: HarnessConfiguration = DEFAULT_HARNESS_DEFAULTS[harness],
  productRole?: Exclude<AgentProductRole, 'operator'>,
): Agent {
  const exact = structuredClone(configuration.harness === harness
    ? configuration
    : DEFAULT_HARNESS_DEFAULTS[harness])
  const legacyEffort = exact.harness === 'codex'
    ? exact.reasoningEffort
    : AgentEffortSchema.safeParse(exact.variant).data
  return {
    id,
    name,
    role: 'Agent',
    ...(productRole ? { productRole, role: productRole === 'orchestrator' ? 'Orchestrator' : 'Coder' } : {}),
    harness,
    model: exact.model,
    effort: legacyEffort,
    ...(exact.harness === 'codex' ? { fastMode: exact.serviceTier === 'priority' } : {}),
    harnessConfiguration: exact,
  }
}

export function nextCoderAgentName(agents: readonly Agent[]): string {
  const highest = agents.reduce((current, agent) => {
    const match = /^coder-(\d{3,})$/i.exec(agent.name.trim())
    const number = match ? Number(match[1]) : 0
    return Number.isSafeInteger(number) ? Math.max(current, number) : current
  }, 0)
  return `coder-${String(highest + 1).padStart(3, '0')}`
}

export function nextHarnessAgentName(
  harness: NonNullable<Agent['harness']>,
  agents: readonly Agent[],
): string {
  const prefix = harness === 'codex' ? 'codex' : 'opencode'
  const pattern = new RegExp(`^${prefix}-(\\d{3,})$`, 'i')
  const highest = agents.reduce((current, agent) => {
    const match = pattern.exec(agent.name.trim())
    return match ? Math.max(current, Number(match[1])) : current
  }, 0)
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`
}
