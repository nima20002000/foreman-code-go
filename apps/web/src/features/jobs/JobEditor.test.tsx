import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { it, expect, vi } from 'vitest'
import { server } from '../../mocks/server'
import { JobEditor } from './JobEditor'
import { definition } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs'
it('offers only qualified authoritative choices and preserves exact selected pins in save', async () => {
  const saved: unknown[] = []
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ targets: [{ id: 'target-a', label: 'Qualified PC', target: definition.spec.target, ready: true, reasons: [] }, { id: 'target-b', label: 'Laptop', target: definition.spec.target, ready: false, reasons: ['Required isolation unavailable'] }], sources: [definition.spec.source], policies: [definition.spec.policy] })), http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })), http.post(`${root}/definitions`, async ({ request }) => { saved.push(await request.json()); return HttpResponse.json({ definition }) }))
  render(<QueryClientProvider client={new QueryClient()}><JobEditor workspaceId={definition.workspaceId} onClose={vi.fn()} /></QueryClientProvider>)
  const user = userEvent.setup()
  expect(await screen.findByRole('option', { name: 'Laptop — Required isolation unavailable' })).toBeDisabled()
  await user.type(screen.getByRole('textbox', { name: 'Job name' }), definition.name)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Computer and validated root' }), 'target-a')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Pinned source snapshot' }), `${definition.spec.source.snapshotId}:${definition.spec.source.manifestDigest}`)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Qualified isolation and toolchain policy' }), `${definition.spec.policy.isolationPolicyId}:${definition.spec.policy.isolationPolicyRevision}:${definition.spec.policy.toolchainDigest}`)
  await user.click(screen.getByRole('button', { name: 'Save job definition' }))
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ expectedRevision: null, name: definition.name, spec: { ...definition.spec, outputs: [] } })
})
it('edits a saved definition without changing historic accepted facts', async () => {
  const oldSource = JSON.stringify(definition.spec.source)
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ targets: [], sources: [], policies: [] })))
  render(<QueryClientProvider client={new QueryClient()}><JobEditor workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} /></QueryClientProvider>)
  await userEvent.type(screen.getByRole('textbox', { name: 'Job name' }), ' edited')
  expect(JSON.stringify(definition.spec.source)).toBe(oldSource)
  expect(screen.getByText(/Existing execution snapshots stay unchanged/)).toBeInTheDocument()
})
