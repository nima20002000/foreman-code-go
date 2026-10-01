import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompatibilityHarness, HarnessCompatibility, HarnessCompatibilityList, HarnessQualificationListSchema } from '@graphql/contracts'
import type { z } from 'zod'
import { server } from '../../mocks/server'
import { ToastProvider } from '../../shared/ui/nocturne'
import { harnessCompatibilityKey } from '../../shared/api/harnessCompatibility'
import { harnessQualificationKey } from '../../shared/api/harnessQualification'
import { HarnessCompatibilityPanel } from './HarnessCompatibilityPanel'

function report(harness: CompatibilityHarness, status: HarnessCompatibility['status'] = 'probe-failed'): HarnessCompatibility {
  const codex = harness === 'codex'
  const release = {
    version: codex ? '0.154.0' : '1.18.31',
    repository: codex ? 'openai/codex' as const : 'anomalyco/opencode' as const,
    tag: codex ? 'rust-v0.154.0' : 'v1.18.31',
    releaseUrl: codex ? 'https://github.com/openai/codex/releases/tag/rust-v0.154.0' : 'https://github.com/anomalyco/opencode/releases/tag/v1.18.31',
    commit: 'a'.repeat(40), recordedAt: '2026-09-19T00:00:00.000Z',
  }
  return {
    harness, checkId: codex ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    installedVersion: status === 'known-compatible' ? release.version : '99.0.0', status,
    checkedAt: '2026-09-19T10:00:00.000Z', source: status === 'known-compatible' ? 'release-record' : 'local-probe',
    checkerRevision: 'protocol-settings-v1', qualifiedRelease: release,
    knownRelease: status === 'known-compatible' ? release : null, matchesQualifiedVersion: status === 'known-compatible',
    reason: status === 'probe-failed' ? { code: 'PROTOCOL_SETTINGS_UNSUPPORTED', message: 'The installed settings schema is unsupported.' } : null,
    schemaSha256: status === 'probe-passed' ? 'f'.repeat(64) : null,
    cacheWarning: null, scope: 'protocol-settings-diagnostic-only',
  }
}
const clients: QueryClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.clear() })
function mount(value: HarnessCompatibilityList, harness: CompatibilityHarness = 'codex') {
  server.use(http.get('*/api/management/harnesses/compatibility', () => HttpResponse.json(value)))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ToastProvider><HarnessCompatibilityPanel harness={harness} /></ToastProvider></QueryClientProvider>)
  return client
}
const both = (): HarnessCompatibilityList => ({ canRetry: true, harnesses: [report('codex'), report('opencode', 'known-compatible')] })
type Qualification = z.infer<typeof HarnessQualificationListSchema>['qualifications'][number]
const qualification = (status: Qualification['status'], failureReason: string | null = null): Qualification => ({
  harness: 'codex', version: '0.158.0', binarySha256: 'a'.repeat(64), status,
  profile: status === 'qualified' || status === 'baseline' ? 'codex-0.156' : null,
  suiteRevision: 'suite-v1', checks: [], failureReason,
  startedAt: status === 'qualifying' ? '2026-09-28T10:00:00.000Z' : null,
  checkedAt: status === 'qualifying' ? null : '2026-09-28T10:01:00.000Z',
})

describe('Harness Settings compatibility feedback', () => {
  it('shows the installed version and trust from qualification, not the diagnostic probe', async () => {
    server.use(http.get('*/api/management/harnesses/qualifications', () => HttpResponse.json({ qualifications: [qualification('qualified')] })))
    mount(both())
    const row = await screen.findByLabelText('Codex qualification')
    expect(await within(row).findByText('Installed 0.158.0')).toBeInTheDocument()
    expect(within(row).getByRole('status')).toHaveTextContent('Trusted')
    expect(within(row).getByRole('button', { name: 'Check' })).toBeEnabled()
  })
  it('checks once, disables the button while qualifying, and reads back a failure', async () => {
    let current = qualification('unqualified')
    let posts = 0
    server.use(
      http.get('*/api/management/harnesses/qualifications', () => HttpResponse.json({ qualifications: [current] })),
      http.post('*/api/management/harnesses/codex/qualification', () => {
        posts++
        current = qualification('qualifying')
        return HttpResponse.json(current, { status: 202 })
      }),
    )
    const client = mount(both())
    const row = await screen.findByLabelText('Codex qualification')
    expect(await within(row).findByText('Failed')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Check' }))
    await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('Checking…'))
    expect(within(row).getByRole('button', { name: 'Check' })).toBeDisabled()
    expect(posts).toBe(1)
    current = qualification('failed', 'Live turn failed.')
    await act(async () => { await client.invalidateQueries({ queryKey: harnessQualificationKey }) })
    expect(await within(row).findByText('Live turn failed.')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Check' })).toBeEnabled()
  })
  it('shows a denied qualification request without claiming trust', async () => {
    server.use(http.post('*/api/management/harnesses/codex/qualification', () => HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Forbidden.' } }, { status: 403 })))
    mount(both())
    const row = await screen.findByLabelText('Codex qualification')
    fireEvent.click(within(row).getByRole('button', { name: 'Check' }))
    expect(await within(row).findByRole('alert')).toHaveTextContent('Forbidden.')
    expect(within(row).getByRole('status')).toHaveTextContent('Failed')
  })
  it('explains an out-of-sync API without showing a contract error as page content', async () => {
    server.use(http.get('*/api/management/harnesses/compatibility', () => HttpResponse.json({
      error: { code: 'INVALID_REQUEST', message: 'The request does not match its shared contract.' },
    }, { status: 400 })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><ToastProvider><HarnessCompatibilityPanel harness="codex" /></ToastProvider></QueryClientProvider>)
    const panel = await screen.findByRole('region', { name: 'Codex installation' })
    expect(await within(panel).findByText(/running API may be out of sync/)).toBeVisible()
    expect(within(panel).queryByText(/shared contract/)).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeEnabled()
  })
  it('shows observed and qualified versions separately, with a failure and repair action', async () => {
    mount(both())
    const card = await screen.findByRole('region', { name: 'Codex installation' })
    expect(await within(card).findByText('99.0.0')).toBeInTheDocument()
    expect(within(card).getByText('Check failed')).toBeInTheDocument()
    expect(within(card).getByText(/installed settings schema is unsupported/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Retry Codex check' })).toBeEnabled()
    fireEvent.click(within(card).getByText('Check details and repair'))
    expect(within(card).getByRole('link', { name: 'Official Codex 0.154.0 release' })).toHaveAttribute('href', 'https://github.com/openai/codex/releases/tag/rust-v0.154.0')
  })
  it('keeps an unknown passing release visibly unqualified, including cache problems', async () => {
    const value = both()
    value.harnesses[0] = { ...report('codex', 'probe-passed'), cacheWarning: 'The result could not be saved to the cache.' }
    mount(value, 'codex')
    const card = await screen.findByRole('region', { name: 'Codex installation' })
    expect(await within(card).findByText('Check passed; execution blocked')).toBeInTheDocument()
    expect(within(card).getByText(/not qualified for execution/)).toBeInTheDocument()
    fireEvent.click(within(card).getByText('Check details and repair'))
    expect(within(card).getByText(/remains blocked by the exact-version execution gate/)).toBeInTheDocument()
    expect(within(card).getByText(/could not be saved/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'OpenCode installation' })).not.toBeInTheDocument()
  })
  it('retains the last report after a refresh failure and offers refresh', async () => {
    const client = mount(both())
    await screen.findByText('99.0.0')
    server.use(http.get('*/api/management/harnesses/compatibility', () => HttpResponse.json({ error: { code: 'OFFLINE', message: 'API offline.' } }, { status: 503 })))
    await act(async () => { await client.invalidateQueries({ queryKey: harnessCompatibilityKey }) })
    expect(await screen.findByText(/Could not refresh. The last result is still shown/)).toBeInTheDocument()
    expect(screen.getByText('99.0.0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })
  it('disables retries when the API grants viewing only', async () => {
    mount({ ...both(), canRetry: false })
    expect(await screen.findByRole('button', { name: 'Retry Codex check' })).toBeDisabled()
    fireEvent.click(screen.getByText('Check details and repair'))
    expect(screen.getByText(/Retry requires harness update access/)).toBeInTheDocument()
  })
  it('reports a requested retry once and waits for server completion, not click completion', async () => {
    let value = both()
    const client = mount(value)
    const checking = { ...report('codex', 'checking'), checkId: '33333333-3333-4333-8333-333333333333' }
    let attempts = 0
    server.use(
      http.get('*/api/management/harnesses/compatibility', () => HttpResponse.json(value)),
      http.post('*/api/management/harnesses/codex/compatibility/retry', async ({ request }) => {
        expect(await request.json()).toEqual({})
        attempts++
        value = { ...value, harnesses: [checking, report('opencode', 'known-compatible')] }
        return HttpResponse.json(checking, { status: 202 })
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Codex check' }))
    expect(await screen.findByText('Checking Codex compatibility')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Checking Codex…' })).toBeDisabled()
    value = { ...value, harnesses: [{ ...report('codex', 'probe-passed'), checkId: checking.checkId }, report('opencode', 'known-compatible')] }
    await act(async () => { await client.invalidateQueries({ queryKey: harnessCompatibilityKey }) })
    expect(await screen.findByText('Codex local check passed')).toBeInTheDocument()
    await act(async () => { await client.invalidateQueries({ queryKey: harnessCompatibilityKey }) })
    expect(screen.getAllByText('Codex local check passed')).toHaveLength(1)
    expect(attempts).toBe(1)
  })
  it('provides an actionable permission error toast without changing the report', async () => {
    mount(both())
    server.use(http.post('*/api/management/harnesses/codex/compatibility/retry', () => HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Forbidden.' } }, { status: 403 })))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Codex check' }))
    expect(await screen.findByText(/Your account cannot retry harness checks/)).toBeInTheDocument()
    expect(screen.getByText('Check failed')).toBeInTheDocument()
  })
})
