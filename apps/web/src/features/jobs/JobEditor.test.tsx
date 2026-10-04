import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { it, expect, vi } from 'vitest'
import { server } from '../../mocks/server'
import { JobEditor } from './JobEditor'
import { definition } from './fixtures'
import { jobPolicyRequirements } from '@graphql/contracts/jobs'
const root = '*/api/management/workspaces/:workspaceId/jobs'
it('defaults to Auto and saves runtime requirements while every computer is offline', async () => {
  const limits = { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 32, diskBytes: 8388608 }
  const requirement = { policy: jobPolicyRequirements(definition.spec.policy), limits }
  const saved: unknown[] = []
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ targets: [], sources: [definition.spec.source],
    policies: [], autoPolicies: [requirement] })),
  http.post(`${root}/validate`, () => HttpResponse.json({ valid: true, reasons: [], sideEffects: false })),
  http.post(`${root}/definitions`, async ({ request }) => {
    const input = await request.json() as { spec: unknown }
    saved.push(input)
    return HttpResponse.json({ definition: { ...definition, spec: input.spec } })
  }))
  render(<QueryClientProvider client={new QueryClient()}><JobEditor workspaceId={definition.workspaceId} onClose={vi.fn()} /></QueryClientProvider>)
  const user = userEvent.setup()
  expect(screen.getByRole('combobox', { name: 'Computer and validated root' })).toHaveValue('auto')
  await screen.findByRole('option', { name: /Image/ })
  await user.type(screen.getByRole('textbox', { name: 'Job name' }), 'Automatic build')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Pinned source snapshot' }),
    `${definition.spec.source.snapshotId}:${definition.spec.source.manifestDigest}`)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Required isolation and toolchain policy' }), '0')
  await user.click(screen.getByRole('button', { name: 'Save job definition' }))
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ spec: { target: { kind: 'auto' }, policy: requirement.policy, limits,
    source: definition.spec.source } })
})
it('keeps the full long Job name as its focused dialog title and allows Close', async () => {
  const longDefinition = { ...definition, name: '長い名前'.repeat(50) }
  const close = vi.fn()
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ targets: [], sources: [], policies: [] })))
  render(<QueryClientProvider client={new QueryClient()}><JobEditor workspaceId={definition.workspaceId} definition={longDefinition} onClose={close} /></QueryClientProvider>)
  const heading = screen.getByRole('heading', { name: `Edit ${longDefinition.name}` })
  expect(heading).toHaveFocus()
  await screen.findByText('No computer and validated source root')
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
  expect(close).toHaveBeenCalledOnce()
})
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
  expect(screen.getByRole('option', { name: `Commit ${definition.spec.source.commit.slice(0, 8)}…` })).toBeInTheDocument()
  expect(screen.getByText(`Selected policy: network ${definition.spec.policy.network}; execution limit ${definition.spec.policy.executionTimeoutMs} ms.`)).toBeVisible()
  const details = screen.getByText('Review exact saved specification').closest('details')!
  await user.click(within(details).getByText('Review exact saved specification'))
  expect(within(details).getByText(/"snapshotId"/)).toHaveTextContent(definition.spec.source.snapshotId)
  expect(within(details).getByText(/"snapshotId"/)).toHaveTextContent(definition.spec.source.commit)
  expect(within(details).getByText(/"snapshotId"/)).toHaveTextContent(`"isolationPolicyRevision": ${definition.spec.policy.isolationPolicyRevision}`)
  await user.click(screen.getByRole('button', { name: 'Save job definition' }))
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ expectedRevision: null, name: definition.name, spec: { ...definition.spec, outputs: [] } })
})
it('disambiguates repeated commit and policy labels and exposes exact pins before the form is complete', async () => {
  const secondSource = { ...definition.spec.source, snapshotId: '33333333-3333-4333-8333-333333333333' }
  const secondPolicy = { ...definition.spec.policy, toolchainDigest: 'd'.repeat(64) }
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ targets: [], sources: [definition.spec.source, secondSource], policies: [definition.spec.policy, secondPolicy] })))
  render(<QueryClientProvider client={new QueryClient()}><JobEditor workspaceId={definition.workspaceId} onClose={vi.fn()} /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Computer and validated root' }), 'fixed')
  const sourceChoice = await screen.findByRole('option', { name: `Commit ${secondSource.commit.slice(0, 8)}… · ${secondSource.snapshotId.slice(0, 8)}…` })
  await user.selectOptions(screen.getByRole('combobox', { name: 'Pinned source snapshot' }), sourceChoice)
  const policyChoice = screen.getByRole('option', { name: `${secondPolicy.isolationPolicyId} · rev ${secondPolicy.isolationPolicyRevision} · dddddddd…` })
  await user.selectOptions(screen.getByRole('combobox', { name: 'Qualified isolation and toolchain policy' }), policyChoice)
  await user.click(screen.getByText('Review selected configuration'))
  const specification = screen.getByText(/"snapshotId"/)
  expect(specification).toHaveTextContent(secondSource.snapshotId)
  expect(specification).toHaveTextContent(secondPolicy.toolchainDigest)
  expect(specification).toHaveTextContent(`"network": "${secondPolicy.network}"`)
  expect(screen.getByRole('button', { name: 'Save job definition' })).toBeDisabled()
})
it('edits a saved definition without changing historic accepted facts', async () => {
  const oldSource = JSON.stringify(definition.spec.source)
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ targets: [], sources: [], policies: [] })))
  render(<QueryClientProvider client={new QueryClient()}><JobEditor workspaceId={definition.workspaceId} definition={definition} onClose={vi.fn()} /></QueryClientProvider>)
  await userEvent.type(screen.getByRole('textbox', { name: 'Job name' }), ' edited')
  expect(JSON.stringify(definition.spec.source)).toBe(oldSource)
  expect(screen.getByText(/Existing execution snapshots stay unchanged/)).toBeInTheDocument()
})

it('distinguishes loading choices from missing human-approved setup', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  server.use(http.get(`${root}/choices`, async () => { await gate; return HttpResponse.json({ targets: [], sources: [], policies: [] }) }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><JobEditor workspaceId={definition.workspaceId} onClose={vi.fn()} /></QueryClientProvider>)
  expect(screen.getByText('Loading authorized job choices…')).toBeInTheDocument()
  expect(screen.queryByText('No approved Git source snapshot')).not.toBeInTheDocument()
  await act(async () => { release(); await gate })
  expect(await screen.findByText('No computer and validated source root')).toBeInTheDocument()
  expect(screen.getByText('No approved Git source snapshot')).toBeInTheDocument()
  expect(screen.getByText('No qualified CI runtime policy')).toBeInTheDocument()
  expect(screen.getByText(/A person must approve a Git source/)).toBeInTheDocument()
  expect(screen.getByText(/CI isolation needs human-approved runtime, image and bounded storage setup/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save job definition' })).toBeDisabled()
})
it('explains unavailable computer roots even when choices exist and preserves their specific reasons', async () => {
  server.use(http.get(`${root}/choices`, () => HttpResponse.json({ targets: [{ id: 'blocked', label: 'Computer', target: definition.spec.target, ready: false, reasons: ['SOURCE_READ_ONLY'] }], sources: [definition.spec.source], policies: [definition.spec.policy] })))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><JobEditor workspaceId={definition.workspaceId} onClose={vi.fn()} /></QueryClientProvider>)
  expect(await screen.findByText('No computer and validated source root')).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Computer — SOURCE_READ_ONLY' })).toBeDisabled()
  expect(screen.queryByText('No approved Git source snapshot')).not.toBeInTheDocument()
  expect(screen.queryByText('No qualified CI runtime policy')).not.toBeInTheDocument()
})
