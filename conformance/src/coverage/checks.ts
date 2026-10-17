import { httpRoutes, type HttpRoute } from './http-routes.js'
import type { Scenario } from '../scenario.js'

export interface CoverageResult {
  status: 'passed' | 'failed'
  required: number
  covered: number
  missing: string[]
  unexpected: string[]
}

function compareCoverage(requiredValues: readonly string[], coveredValues: readonly string[]): CoverageResult {
  const required = new Set(requiredValues)
  const covered = new Set(coveredValues)
  if (required.size !== requiredValues.length) throw new Error('Coverage inventory contains duplicate requirements')
  const missing = [...required].filter(value => !covered.has(value)).sort()
  const unexpected = [...covered].filter(value => !required.has(value)).sort()
  return {
    status: required.size > 0 && missing.length === 0 && unexpected.length === 0 ? 'passed' : 'failed',
    required: required.size,
    covered: [...covered].filter(value => required.has(value)).length,
    missing,
    unexpected,
  }
}

export function checkHttpCoverage(routes: readonly HttpRoute[], scenarios: readonly Scenario[]): CoverageResult {
  const required = routes.flatMap(route => ['success', 'error'].map(variant =>
    `${route.transport} ${route.method} ${route.path} ${variant}`))
  const covered = scenarios.flatMap(scenario => (scenario.covers ?? []).flatMap(claim => {
    if (claim.surface !== 'http') return []
    return [`${claim.transport ?? 'http'} ${claim.method} ${claim.path} ${claim.case}`]
  }))
  return compareCoverage(required, covered)
}

/** tools/list must be from the running target, including every cursor page. */
export function checkMcpCoverage(advertisedToolNames: readonly string[], scenarios: readonly Scenario[]): CoverageResult {
  if (new Set(advertisedToolNames).size !== advertisedToolNames.length) {
    throw new Error('The target advertised duplicate MCP tool names')
  }
  const required = advertisedToolNames.flatMap(tool => ['success', 'denied', 'readback'].map(variant => `${tool} ${variant}`))
  const covered = scenarios.flatMap(scenario => (scenario.covers ?? []).flatMap(claim => {
    if (claim.surface !== 'mcp') return []
    return [`${claim.tool} ${claim.case}`]
  }))
  return compareCoverage(required, covered)
}

export function checkBehaviorCoverage(scenarios: readonly Scenario[]): CoverageResult {
  const required = [
    'workflow ordinary success', 'workflow repeat success', 'workflow handoff-join success',
    'workflow interactions-resume success', 'workflow retry success', 'workflow stop success',
    'workflow interval success', 'workflow schedule success', 'workflow jobs success',
    'workflow restart-recovery success',
    'codec image-resize success', 'codec image-rotate success', 'codec animated-gif success',
    'codec animated-webp success', 'codec pdf-read success', 'codec pdf-append success',
    'codec docx-read success', 'codec docx-edit success',
    ...httpRoutes.filter(route => route.method === 'GET' && route.transport === 'sse')
      .flatMap(route => ['framing', 'order', 'reconnect'].map(variant => `stream ${route.path} ${variant}`)),
  ]
  const covered = scenarios.flatMap(scenario => (scenario.covers ?? []).flatMap(claim => {
    if (claim.surface === 'http' || claim.surface === 'mcp') return []
    return [`${claim.surface} ${claim.name} ${claim.case}`]
  }))
  return compareCoverage(required, covered)
}
