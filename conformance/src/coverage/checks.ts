import { httpRoutes, type HttpRoute } from './http-routes.js'
import type { Scenario } from '../scenario.js'
import type { Lane } from '../reporting/types.js'

export interface CoverageRequirement {
  requirement: string
  lane?: Lane
  provenance?: string
}

export interface CoverageDeclaration {
  requirement: string
  scenarioId: string
  lane: Lane
}

export interface CoverageMapping extends CoverageRequirement {
  scenarioIds: string[]
}

export interface CoverageGroup {
  lane: Lane
  provenance: string
  required: number
  covered: number
  missing: string[]
}

export interface CoverageResult {
  basis: 'authored-scenario-declarations'
  status: 'passed' | 'failed'
  required: number
  covered: number
  missing: string[]
  unexpected: string[]
  requirements: CoverageMapping[]
  declarations: CoverageDeclaration[]
  groups: CoverageGroup[]
}

function coverageGroups(requirements: readonly CoverageRequirement[], covered: ReadonlySet<string>): CoverageGroup[] {
  const groups = new Map<string, CoverageGroup>()
  for (const requirement of requirements) {
    if (!requirement.lane || !requirement.provenance) continue
    const provenance = requirement.provenance.replace(/:\d+$/, '')
    const key = `${requirement.lane} ${provenance}`
    let group = groups.get(key)
    if (!group) {
      group = { lane: requirement.lane, provenance, required: 0, covered: 0, missing: [] }
      groups.set(key, group)
    }
    group.required += 1
    if (covered.has(requirement.requirement)) group.covered += 1
    else group.missing.push(requirement.requirement)
  }
  return [...groups.values()].sort((left, right) =>
    left.lane.localeCompare(right.lane) || left.provenance.localeCompare(right.provenance))
}

function compareCoverage(requiredValues: readonly CoverageRequirement[], declarations: readonly CoverageDeclaration[]): CoverageResult {
  const required = new Set(requiredValues.map(value => value.requirement))
  const covered = new Set(declarations.map(value => value.requirement))
  if (required.size !== requiredValues.length) throw new Error('Coverage inventory contains duplicate requirements')
  const missing = [...required].filter(value => !covered.has(value)).sort()
  const unexpected = [...covered].filter(value => !required.has(value)).sort()
  return {
    basis: 'authored-scenario-declarations',
    status: required.size > 0 && missing.length === 0 && unexpected.length === 0 ? 'passed' : 'failed',
    required: required.size,
    covered: [...covered].filter(value => required.has(value)).length,
    missing,
    unexpected,
    requirements: requiredValues.map(value => ({ ...value,
      scenarioIds: [...new Set(declarations.filter(declaration => declaration.requirement === value.requirement)
        .map(declaration => declaration.scenarioId))].sort(),
    })),
    declarations: [...declarations],
    groups: coverageGroups(requiredValues, covered),
  }
}

export function checkHttpCoverage(routes: readonly HttpRoute[], scenarios: readonly Scenario[]): CoverageResult {
  const required = routes.flatMap(route => ['success', 'error'].map(variant => ({
    requirement: `${route.transport} ${route.method} ${route.path} ${variant}`,
    lane: route.lane, provenance: route.provenance,
  })))
  const covered = scenarios.flatMap(scenario => (scenario.covers ?? []).flatMap(claim => {
    if (claim.surface !== 'http') return []
    return [{ requirement: `${claim.transport ?? 'http'} ${claim.method} ${claim.path} ${claim.case}`,
      scenarioId: scenario.id, lane: scenario.lane }]
  }))
  return compareCoverage(required, covered)
}

/** tools/list must be from the running target, including every cursor page. */
export function checkMcpCoverage(advertisedToolNames: readonly string[], scenarios: readonly Scenario[]): CoverageResult {
  if (new Set(advertisedToolNames).size !== advertisedToolNames.length) {
    throw new Error('The target advertised duplicate MCP tool names')
  }
  const required = advertisedToolNames.flatMap(tool => ['success', 'denied', 'readback']
    .map(variant => ({ requirement: `${tool} ${variant}` })))
  const covered = scenarios.flatMap(scenario => (scenario.covers ?? []).flatMap(claim => {
    if (claim.surface !== 'mcp') return []
    return [{ requirement: `${claim.tool} ${claim.case}`, scenarioId: scenario.id, lane: scenario.lane }]
  }))
  return compareCoverage(required, covered)
}

export function checkBehaviorCoverage(scenarios: readonly Scenario[]): CoverageResult {
  const required = [
    'workflow ordinary success', 'workflow repeat success', 'workflow work-handoff success', 'workflow join success',
    'workflow interactions-resume success', 'workflow retry success', 'workflow stop success',
    'workflow interval success', 'workflow schedule success', 'workflow jobs success',
    'workflow restart-recovery success',
    'codec image-resize success', 'codec image-rotate success', 'codec animated-gif success',
    'codec animated-webp success', 'codec pdf-read success', 'codec pdf-append success',
    'codec docx-read success', 'codec docx-edit success',
    'harness codex-native success', 'harness claude-native success',
    ...httpRoutes.filter(route => route.method === 'GET' && route.transport === 'sse')
      .flatMap(route => ['framing', 'order', 'reconnect'].map(variant => `stream ${route.path} ${variant}`)),
  ]
  const covered = scenarios.flatMap(scenario => (scenario.covers ?? []).flatMap(claim => {
    if (claim.surface === 'http' || claim.surface === 'mcp') return []
    return [{ requirement: `${claim.surface} ${claim.name} ${claim.case}`, scenarioId: scenario.id, lane: scenario.lane }]
  }))
  return compareCoverage(required.map(requirement => ({ requirement })), covered)
}
