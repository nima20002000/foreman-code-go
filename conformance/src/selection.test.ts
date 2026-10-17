import { describe, expect, it } from 'vitest'
import { selectScenarios } from './selection.js'

const health = { id: 'health.live', lane: 'SKEL' as const }
const workspace = { id: 'workspace.create', lane: 'A2' as const }
const run = { id: 'run.ordinary', lane: 'E' as const }
const registry = [health, workspace, run]
const smoke = [health, workspace]
const unfiltered = { smoke: false, lanes: [], scenarioIds: [] }

function selectionError(options: Parameters<typeof selectScenarios>[2]): unknown {
  try { return selectScenarios(registry, smoke, options) }
  catch (error) { return error }
}

describe('conformance scenario selection', () => {
  it('preserves the full registry and its order for an intentional unfiltered run', () => {
    const selected = selectScenarios(registry, smoke, unfiltered)
    expect(selected).toEqual(registry)
    expect(selected[0]).toBe(health)
  })

  it('combines the smoke and lane filters', () => {
    expect(selectScenarios(registry, smoke, { ...unfiltered, smoke: true, lanes: ['A2'] }))
      .toEqual([workspace])
  })

  it('keeps registry order and executes a repeated exact ID only once', () => {
    expect(selectScenarios(registry, smoke, {
      ...unfiltered, scenarioIds: ['run.ordinary', 'health.live', 'run.ordinary'],
    })).toEqual([health, run])
  })

  it('rejects a mixed known and unknown selection with the exact requested and matched IDs', () => {
    expect(selectionError({ ...unfiltered, scenarioIds: ['health.live', 'health.lvie'] }))
      .toMatchObject({ name: 'ScenarioSelectionError', details: {
        requestedScenarioIds: ['health.live', 'health.lvie'],
        selectedScenarioIds: ['health.live'],
        unknownScenarioIds: ['health.lvie'],
        excludedScenarioIds: [],
      } })
  })

  it('rejects an unknown-only selection without replacing it with the registry', () => {
    expect(selectionError({ ...unfiltered, scenarioIds: ['missing'] }))
      .toMatchObject({ name: 'ScenarioSelectionError', details: {
        requestedScenarioIds: ['missing'], selectedScenarioIds: [],
        unknownScenarioIds: ['missing'], excludedScenarioIds: [],
      } })
  })

  it('does not trim or partially match an explicit scenario ID', () => {
    expect(selectionError({ ...unfiltered, scenarioIds: [' health.live', 'run.'] }))
      .toMatchObject({ name: 'ScenarioSelectionError', details: {
        requestedScenarioIds: [' health.live', 'run.'], selectedScenarioIds: [],
        unknownScenarioIds: [' health.live', 'run.'], excludedScenarioIds: [],
      } })
  })

  it('distinguishes known IDs excluded by the smoke filter from unknown IDs', () => {
    expect(selectionError({ ...unfiltered, smoke: true, scenarioIds: ['health.live', 'run.ordinary'] }))
      .toMatchObject({ name: 'ScenarioSelectionError', details: {
        requestedScenarioIds: ['health.live', 'run.ordinary'], selectedScenarioIds: ['health.live'],
        unknownScenarioIds: [], excludedScenarioIds: ['run.ordinary'],
      } })
  })

  it('rejects a requested ID excluded by the lane filter instead of running the remainder', () => {
    expect(selectionError({ ...unfiltered, lanes: ['SKEL'], scenarioIds: ['health.live', 'workspace.create'] }))
      .toMatchObject({ name: 'ScenarioSelectionError', details: {
        requestedScenarioIds: ['health.live', 'workspace.create'], selectedScenarioIds: ['health.live'],
        unknownScenarioIds: [], excludedScenarioIds: ['workspace.create'],
      } })
  })

  it('rejects an empty lane selection without falling back to the registry', () => {
    expect(selectionError({ ...unfiltered, lanes: ['J'] }))
      .toMatchObject({ name: 'ScenarioSelectionError', message: 'Conformance selection is empty', details: {
        requestedScenarioIds: [], selectedScenarioIds: [], unknownScenarioIds: [], excludedScenarioIds: [],
      } })
  })
})
