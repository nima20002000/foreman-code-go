import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { BuildComputerUpdate } from '@foreman-code/contracts/build-computers'
import { server } from '../../mocks/server'
import { computerKey } from '../../shared/api/computerActivity'
import { ComputerRows } from './ComputerRows'
import { computersFixture, deviceName, deviceTarget, mainId, mainTarget, registration } from './computersTestFixture'

function rows() {
  return within(screen.getByRole('list', { name: 'Computers in build priority order' })).getAllByRole('listitem')
}
async function ready() {
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Move .+ (up|down)$/ })
    .filter(button => !(button as HTMLButtonElement).disabled)).toHaveLength(2))
}
it('shows Main and paired computers as rows with presence, roles, build controls and utilization', async () => {
  computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  expect(rows()).toHaveLength(2)
  expect(rows()[0]).toHaveAccessibleName('Main PC')
  expect(within(rows()[0]!).getByText('Idle')).toBeVisible()
  expect(within(rows()[1]!).getByText('Offline')).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Build role for Main PC' })).toHaveValue('primary')
  expect(screen.getByRole('combobox', { name: `Build role for ${deviceName}` })).toHaveValue('backup')
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeChecked()
  expect(screen.getAllByRole('meter', { name: 'CPU' })).toHaveLength(2)
  expect(screen.getAllByRole('meter', { name: 'Memory' })).toHaveLength(2)
})
it('persists role, allowance and build edits with the latest saved revision', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  const user = userEvent.setup()
  await ready()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Build role for Main PC' }), 'backup')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Increase allowance for Main PC' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Increase allowance for Main PC' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeEnabled())
  await user.click(screen.getByRole('switch', { name: 'Builds on Main PC' }))
  await waitFor(() => expect(f.writes).toHaveLength(3))
  expect(f.writes.map(value => value.expectedRevision)).toEqual([1, 2, 3])
  expect(f.statuses.get(computerKey(mainTarget))?.preference).toMatchObject({
    buildRole: 'backup', buildAllowancePercent: 70, buildEnabled: false,
  })
  expect(new Set(f.writes.map(value => value.commandId)).size).toBe(3)
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).not.toBeChecked())
  expect(screen.getByRole('status', { name: 'Allowance for Main PC' })).toHaveTextContent('70%')
})
it('optimistically reorders with keyboard controls and persists higher priority for the top computer', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  server.use(http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
    const input = await request.json() as BuildComputerUpdate
    f.writes.push(input)
    await held
    return HttpResponse.json(f.update(input))
  }))
  await ready()
  const button = screen.getByRole('button', { name: `Move ${deviceName} up` })
  button.focus()
  await userEvent.setup().keyboard('{Enter}')
  await waitFor(() => expect(rows()[0]).toHaveAccessibleName(deviceName))
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeDisabled()
  release()
  await ready()
  expect(f.writes).toHaveLength(2)
  expect(f.writes.every(value => value.expectedRevision === 1)).toBe(true)
  expect(f.statuses.get(computerKey(deviceTarget))?.preference.buildPriority).toBe(100)
  expect(f.statuses.get(computerKey(mainTarget))?.preference.buildPriority).toBe(0)
  // Moved above a Primary, the former Backup is now a Primary so Auto placement tries it first.
  expect(f.statuses.get(computerKey(deviceTarget))?.preference.buildRole).toBe('primary')
  expect(screen.getByRole('combobox', { name: `Build role for ${deviceName}` })).toHaveValue('primary')
})
it('reorders by dragging and reuses command IDs after an uncertain response', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  server.use(http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
    const input = await request.json() as BuildComputerUpdate
    f.writes.push(input)
    if (f.writes.length === 1) {
      f.update(input)
      return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Try again' } }, { status: 503 })
    }
    if (f.writes.length === 2) return HttpResponse.json(f.statuses.get(computerKey(input.target)))
    return HttpResponse.json(f.update(input))
  }))
  await ready()
  const handle = within(rows()[1]!).getByTitle('Drag to reorder')
  fireEvent.dragStart(handle, { dataTransfer: { setData() {}, effectAllowed: '' } })
  fireEvent.dragOver(rows()[0]!)
  fireEvent.drop(rows()[0]!)
  await waitFor(() => expect(rows()[0]).toHaveAccessibleName(deviceName))
  await ready()
  expect(f.writes).toHaveLength(3)
  expect(f.writes[0]?.commandId).toBe(f.writes[1]?.commandId)
})
it('rolls back optimistic order and completed writes when another computer conflicts', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  server.use(http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
    const input = await request.json() as BuildComputerUpdate
    f.writes.push(input)
    if (f.writes.length === 2) return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Changed elsewhere' } }, { status: 409 })
    return HttpResponse.json(f.update(input))
  }))
  await ready()
  await userEvent.setup().click(screen.getByRole('button', { name: `Move ${deviceName} up` }))
  expect(await screen.findByText('Settings changed elsewhere. Order restored; try again.')).toBeVisible()
  await ready()
  expect(rows()[0]).toHaveAccessibleName('Main PC')
  expect(f.writes).toHaveLength(3)
  expect(f.writes[2]).toMatchObject({ target: deviceTarget, expectedRevision: 2, buildPriority: 50 })
  expect(f.statuses.get(computerKey(deviceTarget))?.preference.buildPriority).toBe(50)
})
it('restores row controls when a save is denied', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  server.use(http.post('*/api/management/settings/build-computers/update', () => HttpResponse.json({
    error: { code: 'ACCESS_DENIED', message: 'Settings permission is required.' },
  }, { status: 403 })))
  await userEvent.setup().click(screen.getByRole('switch', { name: 'Builds on Main PC' }))
  expect(await screen.findByText('Settings permission is required.')).toBeVisible()
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeChecked()
  expect(f.statuses.get(computerKey(mainTarget))?.preference.buildEnabled).toBe(true)
})

it('reports a failed compensation and refreshes persisted priorities instead of hiding partial saves', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  server.use(http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
    const input = await request.json() as BuildComputerUpdate
    f.writes.push(input)
    if (f.writes.length > 1) return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Changed elsewhere' } }, { status: 409 })
    return HttpResponse.json(f.update(input))
  }))
  await ready()
  await userEvent.setup().click(screen.getByRole('button', { name: `Move ${deviceName} up` }))
  expect(await screen.findByText('Some changes could not be restored. Refresh to see the saved order.')).toBeVisible()
  await ready()
  expect(f.writes).toHaveLength(3)
  expect(f.statuses.get(computerKey(deviceTarget))?.preference).toMatchObject({ buildPriority: 100, revision: 2 })
})

it('shows which accounts each computer is signed in to without listing offline computers as signed out', async () => {
  computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  const main = await screen.findByRole('group', { name: 'Accounts' })
  expect(within(main).getByLabelText('Codex: coder@example.com')).toBeInTheDocument()
  expect(within(main).getByRole('button', { name: 'GitHub: octo-owner. Manage GitHub' })).toBeInTheDocument()
  expect(within(main).getByLabelText('OpenCode: OpenCode Go')).toBeInTheDocument()
  expect(within(main).getByLabelText('Claude: signed out')).toBeInTheDocument()
  expect(within(main).getByRole('button', { name: 'Google Drive: not installed. Manage Google Drive' })).toBeInTheDocument()
  expect(screen.getAllByRole('group', { name: 'Accounts' })).toHaveLength(1)
})

it('connects GitHub on a computer with a one-time code and shows the signed-in account', async () => {
  const user = userEvent.setup()
  const state = { polls: 0 }
  const waiting = { loginId: '66666666-6666-4666-8666-666666666666', state: 'waiting', code: 'AB12-CD34',
    verificationUrl: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    account: null, message: null }
  const bodies: unknown[] = []
  server.use(
    http.post('*/api/management/computers/github/login', async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json(waiting) }),
    http.post('*/api/management/computers/github/login/status', () => {
      state.polls++
      return HttpResponse.json(state.polls < 2 ? waiting : { ...waiting, state: 'signed-in', code: null, verificationUrl: null, account: 'new-owner' })
    }),
  )
  computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await user.click(await screen.findByRole('button', { name: 'GitHub: octo-owner. Manage GitHub' }))
  const dialog = await screen.findByRole('dialog', { name: 'GitHub on Main PC' })
  expect(within(dialog).getByText('octo-owner')).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: 'Switch account' }))
  expect(await within(dialog).findByLabelText('One-time code')).toHaveTextContent('AB12-CD34')
  expect(within(dialog).getByRole('link', { name: /github.com\/login\/device/ })).toHaveAttribute('href', 'https://github.com/login/device')
  expect(bodies).toEqual([{ target: mainTarget }])
  await waitFor(() => expect(within(dialog).getByText('new-owner')).toBeInTheDocument(), { timeout: 8000 })
}, 15_000)

it('connects Google Drive on a computer through a Google sign-in link and shows the mounted account', async () => {
  const user = userEvent.setup()
  const state = { polls: 0 }
  const waiting = { loginId: '77777777-7777-4777-8777-777777777777', state: 'waiting',
    authorizationUrl: 'http://127.0.0.1:53682/auth?state=abc', expiresAt: '2026-10-07T00:10:00.000Z', account: null, mountPath: null, message: null }
  const bodies: unknown[] = []
  server.use(
    http.post('*/api/management/computers/drive/connect', async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json(waiting) }),
    http.post('*/api/management/computers/drive/connect/status', () => {
      state.polls++
      return HttpResponse.json(state.polls < 2 ? waiting : { ...waiting, state: 'connected', authorizationUrl: null,
        account: 'owner@gmail.com', mountPath: '/home/owner/Foreman Code Drive' })
    }),
  )
  computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await user.click(await screen.findByRole('button', { name: 'Google Drive: not installed. Manage Google Drive' }))
  const dialog = await screen.findByRole('dialog', { name: 'Google Drive on Main PC' })
  await user.click(within(dialog).getByRole('button', { name: 'Connect Google Drive' }))
  expect(await within(dialog).findByRole('link', { name: /Open Google sign-in/ })).toHaveAttribute('href', waiting.authorizationUrl)
  expect(bodies).toEqual([{ target: mainTarget }])
  await waitFor(() => expect(within(dialog).getByText('owner@gmail.com')).toBeInTheDocument(), { timeout: 8000 })
  expect(within(dialog).getByText('/home/owner/Foreman Code Drive')).toBeInTheDocument()
}, 15_000)

it('shows Main build readiness, failure reasons and the remote execution warning', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  f.statuses.set(computerKey(mainTarget), { ...f.statuses.get(computerKey(mainTarget))!,
    state: 'busy', reasons: ['More available memory is required before another build can start.'],
    remoteExecutionEnabled: false })
  await ready()
  const main = rows()[0]!
  expect(within(main).getByText('Build status')).toBeVisible()
  await userEvent.setup().click(within(main).getByText('Build status'))
  expect(within(main).getByText(/Busy · More available memory is required/)).toBeVisible()
  expect(within(main).getByText('Remote execution disabled on Main')).toBeVisible()
})
it.each(['Main PC', deviceName])('keeps expanded diagnostics below the compact controls for %s', async (name) => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  const target = name === 'Main PC' ? mainTarget : deviceTarget
  f.statuses.set(computerKey(target), { ...f.statuses.get(computerKey(target))!,
    state: 'setup-required', reasons: ['Job execution is not installed on this computer.'],
    remoteExecutionEnabled: false })
  await ready()
  const row = screen.getByRole('listitem', { name })
  const identity = within(row).getByRole('button', { name: `Activity on ${name}` })
  const compactRow = identity.parentElement!
  const summary = within(row).getByText('Build status')
  const disclosure = summary.parentElement!
  expect(within(identity).getByText(name)).toBeVisible()
  expect(disclosure).not.toHaveAttribute('open')

  const user = userEvent.setup()
  await user.click(summary)
  expect(disclosure).toHaveAttribute('open')
  expect(disclosure.parentElement).toBe(row)
  expect(compactRow.parentElement).toBe(row)
  expect(compactRow).not.toContainElement(disclosure)
  expect(compactRow.nextElementSibling).toBe(disclosure)
  expect(within(identity).getByText(name)).toBeVisible()
  expect(within(compactRow).getByRole('switch', { name: `Builds on ${name}` })).toBeEnabled()
  expect(within(compactRow).getByRole('group', { name: `Build allowance for ${name}` })).toBeVisible()
  expect(within(disclosure).getByText(/Setup required · Job execution is not installed/)).toBeVisible()
  expect(within(disclosure).getByText('Remote execution disabled on Main')).toBeVisible()

  await user.click(summary)
  expect(disclosure).not.toHaveAttribute('open')
  expect(within(identity).getByText(name)).toBeVisible()
})
it('explains the preferred computer before fallback priority order', async () => {
  computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  expect(screen.getByText('Auto placement · Preferred computer first · Fallback: Primary before Backup, then top priority')).toBeVisible()
})

it('reads later account pages and explains direct priorities for more than 100 paired computers', async () => {
  const devices = Array.from({ length: 101 }, (_, index) => ({ ...registration,
    deviceId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
    workerInstallationId: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}` }))
  const last = devices.at(-1)!
  const cursor = devices[99]!.deviceId
  const lastTarget = { ...deviceTarget, hostRef: { kind: 'device' as const, mainId, deviceId: last.deviceId },
    applicationInstallationId: last.workerInstallationId }
  const requests: (string | null)[] = []
  const priorities = new Map<string, number>()
  const writes: BuildComputerUpdate[] = []
  const statusFor = (target: BuildComputerUpdate['target']) => ({
    preference: { target, revision: priorities.has(computerKey(target)) ? 2 : 1,
      buildEnabled: true, buildPriority: priorities.get(computerKey(target)) ?? 50,
      buildRole: 'primary', buildAllowancePercent: 100 }, state: 'ready', reasons: [], remoteExecutionEnabled: true,
  })
  computersFixture(<ComputerRows mainId={mainId} devices={devices} />, [
    http.post('*/api/management/settings/build-computers/read', async ({ request }) => {
      const { target } = await request.json() as BuildComputerUpdate
      return HttpResponse.json(statusFor(target))
    }),
    http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
      const input = await request.json() as BuildComputerUpdate
      writes.push(input)
      priorities.set(computerKey(input.target), input.buildPriority)
      return HttpResponse.json(statusFor(input.target))
    }),
    http.get('*/api/management/computers/accounts', ({ request }) => {
      const after = new URL(request.url).searchParams.get('cursor')
      requests.push(after)
      return HttpResponse.json(after ? { computers: [{ target: lastTarget, accounts: {
        observedAt: new Date().toISOString(), accounts: [{ tool: 'github', installed: true, signedIn: true,
          account: 'last-worker', details: [] }] } }], nextCursor: null } : { computers: [], nextCursor: cursor })
    }),
  ])
  const accountButton = await screen.findByTitle('GitHub: last-worker', {}, { timeout: 15000 })
  expect(accountButton).toHaveAccessibleName('GitHub: last-worker. Manage GitHub')
  expect(accountButton).toBeVisible()
  expect(requests).toEqual([null, cursor])
  expect(screen.getByText(/With more than 101 computers, set priorities directly/)).toBeVisible()
  const fields = await waitFor(() => {
    const values = screen.getAllByDisplayValue('50')
    expect(values).toHaveLength(102)
    return values
  }, { timeout: 15000 })
  expect(fields[0]).toHaveAccessibleName(/^Build priority for/)
  const moves = document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Move "]')
  expect(moves).toHaveLength(204)
  expect([...moves].every(button => button.disabled)).toBe(true)
  const lastRow = accountButton.closest('li')!
  const priority = within(lastRow).getByRole('spinbutton', { name: /^Build priority for/ })
  fireEvent.change(priority, { target: { value: '60' } })
  fireEvent.blur(priority)
  await waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 })
  expect(writes[0]).toMatchObject({ target: lastTarget, buildPriority: 60, expectedRevision: 1 })
  expect(priorities.get(computerKey(lastTarget))).toBe(60)
  await waitFor(() => {
    const saved = within(lastRow).getByRole('spinbutton', { name: /^Build priority for/ })
    expect(saved).toHaveValue(60)
    expect(saved).toBeEnabled()
  }, { timeout: 5000 })
}, 30000)
