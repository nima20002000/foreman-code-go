import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { ComputerRows } from './ComputerRows'
import { computersFixture, deviceName, deviceTarget, mainId, registration } from './computersTestFixture'
import { useComputerUi } from './computerUiStore'

const unavailable = () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Computer did not answer' } }, { status: 503 })
afterEach(() => {
  onlineManager.setOnline(true)
  useComputerUi.setState({ github: undefined, drive: undefined })
  vi.useRealTimers()
})

it('keeps management and a targeted retry available after the first account read fails', async () => {
  computersFixture(<ComputerRows mainId={mainId} devices={[]} />, [
    http.get('*/api/management/computers/accounts', unavailable),
  ])
  const button = await screen.findByRole('button', { name: 'GitHub: account state unavailable. Manage GitHub' })
  expect(screen.getByRole('button', { name: 'Google Drive: account state unavailable. Manage Google Drive' })).toBeEnabled()
  await userEvent.click(button)
  expect(await screen.findByRole('dialog', { name: 'GitHub on Main PC' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Retry accounts' }))
  expect(screen.getByText('Account state unavailable')).toBeVisible()
})

it('removes stale signed-in indicators after a failed refresh and recovers with account retry', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[]} />)
  await screen.findByRole('button', { name: 'GitHub: octo-owner. Manage GitHub' })
  server.use(http.get('*/api/management/computers/accounts', unavailable))
  await act(() => f.client.refetchQueries({ queryKey: ['computer-accounts'] }))
  expect(screen.queryByLabelText('Codex: coder@example.com')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'GitHub: account state unavailable. Manage GitHub' })).toBeEnabled()
  server.use(http.get('*/api/management/computers/accounts', () => HttpResponse.json({ computers: [{
    target: deviceTarget, accounts: null,
  }] })))
  await userEvent.click(screen.getByRole('button', { name: 'Retry accounts' }))
  await waitFor(() => expect(f.client.isFetching({ queryKey: ['computer-accounts'] })).toBe(0))
  expect(screen.queryByText('coder@example.com')).not.toBeInTheDocument()
})

it.each([
  { workerInstallationId: '44444444-4444-4444-8444-444444444444' },
  { keyRevision: 2 },
  { authorizationRevision: 2 },
])('rejects old activity and accounts and closes account flows after registration changes: %j', async patch => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />, [
    http.get('*/api/management/computers/accounts', () => HttpResponse.json({ computers: [{
      target: deviceTarget, accounts: { observedAt: new Date().toISOString(), accounts: [
        { tool: 'github', installed: true, signedIn: true, account: 'old-owner', details: [] },
      ] },
    }] })),
  ])
  await screen.findByRole('button', { name: 'GitHub: old-owner. Manage GitHub' })
  const oldRow = screen.getByRole('listitem', { name: deviceName })
  expect(within(oldRow).getByText('Offline')).toBeVisible()
  await userEvent.click(within(oldRow).getByRole('button', { name: /Manage GitHub/ }))
  expect(await screen.findByRole('dialog', { name: `GitHub on ${deviceName}` })).toBeVisible()
  act(() => useComputerUi.getState().openDrive(`${mainId}:${registration.deviceId}`))
  f.rendered.rerender(<QueryClientProvider client={f.client}>
    <ComputerRows mainId={mainId} devices={[{ ...registration, ...patch }]} />
  </QueryClientProvider>)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  const newRow = screen.getByRole('listitem', { name: deviceName })
  expect(within(newRow).getByText('Unavailable')).toBeVisible()
  expect(within(newRow).queryByRole('button', { name: /old-owner/ })).not.toBeInTheDocument()
  expect(within(newRow).getByRole('button', { name: /GitHub: account state unavailable/ })).toBeEnabled()
})

it('marks cached online and activity facts as last observed when polling pauses offline', async () => {
  computersFixture(<ComputerRows mainId={mainId} devices={[]} />)
  await screen.findByText('Idle')
  act(() => onlineManager.setOnline(false))
  expect(await screen.findByText('Last observed: Idle')).toBeVisible()
  expect(screen.queryByText('Idle', { exact: true })).not.toBeInTheDocument()
  expect(screen.getByTitle('Last observed: Online')).not.toHaveAttribute('data-online', 'true')
})

it('marks old activity as last observed when background polling does not refresh it', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[]} />)
  await screen.findByText('Idle')
  vi.useFakeTimers()
  act(() => {
    for (const query of f.client.getQueryCache().findAll({ queryKey: ['computer-activity'] })) {
      f.client.setQueryData(query.queryKey, f.activity, { updatedAt: Date.now() - 20_000 })
    }
  })
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByText('Last observed: Idle')).toBeVisible()
})

it('opens harness account details by keyboard and touch without relying on hover', async () => {
  computersFixture(<ComputerRows mainId={mainId} devices={[]} />)
  const details = await screen.findByLabelText('Codex: coder@example.com')
  details.focus()
  expect(details).toHaveFocus()
  await userEvent.click(details)
  expect(screen.getByText('Codex: coder@example.com')).toBeVisible()
  const openCode = screen.getByLabelText('OpenCode: OpenCode Go')
  fireEvent.click(openCode)
  expect(screen.getByText('OpenCode: OpenCode Go')).toBeVisible()
})

it('rejects a delayed account and activity response after Worker replacement and accepts the new binding', async () => {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let enteredCount = 0
  const replacement = { ...registration, workerInstallationId: '44444444-4444-4444-8444-444444444444' }
  const replacementTarget = { ...deviceTarget, applicationInstallationId: replacement.workerInstallationId }
  let replaced = false
  const waitForOldRead = async () => {
    enteredCount++
    if (enteredCount === 2) entered()
    await held
  }
  const accountList = (target: typeof deviceTarget, owner: string) => ({ computers: [{ target,
    accounts: { observedAt: new Date().toISOString(), accounts: [
      { tool: 'github', installed: true, signedIn: true, account: owner, details: [] },
    ] },
  }] })
  const activityList = (target: typeof deviceTarget) => ({ mainId, activityComplete: true, truncated: false,
    computers: [{ target, name: deviceName, online: true, jobs: [], agents: [] }],
  })
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />, [
    http.get('*/api/management/computers/accounts', async () => {
      if (replaced) return HttpResponse.json(accountList(replacementTarget, 'replacement-owner'))
      await waitForOldRead()
      return HttpResponse.json(accountList(deviceTarget, 'old-owner'))
    }),
    http.get('*/api/management/computers/activity', async () => {
      if (replaced) return HttpResponse.json(activityList(replacementTarget))
      await waitForOldRead()
      return HttpResponse.json(activityList(deviceTarget))
    }),
  ])
  await started
  f.rendered.rerender(<QueryClientProvider client={f.client}>
    <ComputerRows mainId={mainId} devices={[replacement]} />
  </QueryClientProvider>)
  replaced = true
  release()
  await waitFor(() => expect(f.client.isFetching({ queryKey: ['computer-accounts'] })).toBe(0))
  await waitFor(() => expect(f.client.isFetching({ queryKey: ['computer-activity'] })).toBe(0))
  const row = within(screen.getByRole('listitem', { name: deviceName }))
  expect(row.getByText('Unavailable')).toBeVisible()
  expect(row.queryByRole('button', { name: /old-owner/ })).not.toBeInTheDocument()
  await act(async () => {
    await Promise.all([
      f.client.refetchQueries({ queryKey: ['computer-accounts'] }),
      f.client.refetchQueries({ queryKey: ['computer-activity'] }),
    ])
  })
  expect(await row.findByRole('button', { name: 'GitHub: replacement-owner. Manage GitHub' })).toBeVisible()
  expect(row.getByText('Idle')).toBeVisible()
})
