import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { NodePlacementField } from './NodePlacementField'
import { NodePlacementFacts } from './NodePlacementFacts'
import { acceptedPlacementFixture as placement, savedPlacementFixture as saved, workerObservationFixture as observation } from './fixtures'

it('retains removed placement and never silently selects the main computer', async () => {
  const change = vi.fn()
  render(<NodePlacementField value={saved} options={[{ label: 'PC', placement: { ...saved, hostRef: { kind: 'main', mainId: saved.hostRef.mainId } } }]} onChange={change} />)
  expect(screen.getByRole('combobox', { name: 'Computer' })).toHaveValue('retained')
  expect(screen.getByText(/no longer available/)).toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
  await userEvent.selectOptions(screen.getByRole('combobox'), '0')
  expect(change.mock.calls[0]?.[0].hostRef.kind).toBe('main')
})
it('shows restricted or incompatible choices without allowing selection', () => {
  render(<NodePlacementField value={saved} options={[{ label: 'Laptop', placement: saved, unavailableReason: 'Root access restricted' }]} onChange={vi.fn()} />)
  expect(screen.getByRole('option', { name: 'Laptop — Root access restricted' })).toBeDisabled()
  expect(screen.getByText('Root access restricted')).toBeInTheDocument()
  expect(screen.getByText(/Save graph persists/)).toBeInTheDocument()
})
it('renders accepted pins without claiming execution before acknowledgment', () => {
  render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [] }} />)
  expect(screen.getByText('Laptop at acceptance')).toBeInTheDocument()
  expect(screen.getAllByText('/synthetic/accepted', { selector: 'dd' })).toHaveLength(2)
  expect(screen.getByText(/Awaiting worker acknowledgment/)).toBeInTheDocument()
  expect(screen.queryByText(/Execution observed on/)).not.toBeInTheDocument()
})
it('worker acceptance does not claim a process ran; latest matching attempt phase does', () => {
  const view = render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [observation] }} />)
  expect(screen.getByText(/Worker acknowledged acceptance/)).toBeInTheDocument()
  view.rerender(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement,
    observations: [{ ...observation, sequence: '2', phase: 'running', native: { processId: 123 } }, observation,
      { ...observation, attemptId: 'attempt-b', operationId: 'operation-b', executionId: 'execution-b', sequence: '3', phase: 'entered' }] }} />)
  expect(screen.getAllByText(/Execution observed on Laptop at acceptance/)).toHaveLength(1)
  expect(screen.getByText(/Worker entered observation/)).toBeInTheDocument()
  expect(screen.getByText('123')).toBeInTheDocument()
  expect(screen.getByText('attempt-b')).toBeInTheDocument()
})
it('ignores a different binding or worker identity', () => {
  render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [
    { ...observation, phase: 'running', bindingHash: 'b'.repeat(64) },
    { ...observation, phase: 'running', connection: { ...observation.connection, authorizationRevision: 3 } },
  ] }} />)
  expect(screen.queryByText(/Execution observed on/)).not.toBeInTheDocument()
})
it('withdraws private facts on selection change, missing legacy data and access loss', () => {
  const view = render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [] }} />)
  view.rerender(<NodePlacementFacts runId="run-b" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [] }} />)
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
  view.rerender(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'legacy_missing', originalMainInstallationId: null }} />)
  expect(screen.getByText(/Current computer settings are not substituted/)).toBeInTheDocument()
  view.rerender(<NodePlacementFacts runId="run-a" nodeId="node-a" />)
  expect(screen.queryByText('/synthetic/accepted')).not.toBeInTheDocument()
})

it('does not describe a configured host as removed while authorized choices are loading', () => {
  render(<NodePlacementField value={saved} options={[]} optionsState="loading" onChange={vi.fn()} />)
  expect(screen.getByText('Reading authorized computer choices…')).toBeInTheDocument()
  expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument()
})

it('retains earlier process-start evidence when a later terminal observation omits native metadata', () => {
  render(<NodePlacementFacts runId="run-a" nodeId="node-a" readback={{ evidence: 'accepted', placement, observations: [
    { ...observation, sequence: '3', phase: 'terminal' }, { ...observation, sequence: '2', phase: 'running' },
  ] }} />)
  expect(screen.getByText('Execution observed on Laptop at acceptance · terminal')).toBeInTheDocument()
})
