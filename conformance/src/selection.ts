import type { Lane } from './reporting/types.js'

interface SelectionOptions {
  smoke: boolean
  lanes: readonly Lane[]
  scenarioIds: readonly string[]
}

interface SelectionDetails {
  requestedScenarioIds: string[]
  selectedScenarioIds: string[]
  unknownScenarioIds: string[]
  excludedScenarioIds: string[]
}

class ScenarioSelectionError extends Error {
  constructor(message: string, readonly details: SelectionDetails) {
    super(message)
    this.name = 'ScenarioSelectionError'
  }
}

/** Every requested ID must survive the combined filters before a target can start. */
export function selectScenarios<T extends { id: string; lane: Lane }>(
  registry: readonly T[],
  smokeScenarios: readonly T[],
  options: SelectionOptions,
): T[] {
  const candidates = options.smoke ? smokeScenarios : registry
  const selected = candidates.filter(scenario =>
    (options.lanes.length === 0 || options.lanes.includes(scenario.lane))
    && (options.scenarioIds.length === 0 || options.scenarioIds.includes(scenario.id)))
  const known = new Set(registry.map(scenario => scenario.id))
  const selectedIds = new Set(selected.map(scenario => scenario.id))
  const requested = [...new Set(options.scenarioIds)]
  const unknown = requested.filter(id => !known.has(id))
  const excluded = requested.filter(id => known.has(id) && !selectedIds.has(id))
  const details = {
    requestedScenarioIds: [...options.scenarioIds],
    selectedScenarioIds: selected.map(scenario => scenario.id),
    unknownScenarioIds: unknown,
    excludedScenarioIds: excluded,
  }
  if (unknown.length > 0 || excluded.length > 0) {
    throw new ScenarioSelectionError('Every requested scenario ID must match the selected scope', details)
  }
  if (selected.length === 0) throw new ScenarioSelectionError('Conformance selection is empty', details)
  return selected
}
