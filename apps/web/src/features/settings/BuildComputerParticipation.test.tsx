import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { BuildComputerParticipation } from './BuildComputerParticipation'
import { clearRevisionedFormPersistence } from './revisionedForm'
import type { BuildComputerUpdate } from '@foreman-code/contracts/build-computers'

const mainId = '11111111-1111-4111-8111-111111111111'
const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }
it('saves participation and priority independently of the startup gate and reads the saved revision', async () => {
  clearRevisionedFormPersistence()
  let preference = { target, revision: 0, buildEnabled: false, buildPriority: 50 }
  const writes: BuildComputerUpdate[] = []
  const status = () => ({ preference, state: preference.buildEnabled ? 'setup-required' : 'disabled',
    reasons: ['Remote execution disabled on Main.'], remoteExecutionEnabled: false })
  server.use(http.post('*/api/management/settings/build-computers/read', () => HttpResponse.json(status())),
  http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
    const input = await request.json() as BuildComputerUpdate
    writes.push(input)
    preference = { target, revision: 1, buildEnabled: input.buildEnabled, buildPriority: input.buildPriority }
    return HttpResponse.json(status())
  }))
  const rendered = render(<QueryClientProvider client={new QueryClient()}><BuildComputerParticipation target={target} /></QueryClientProvider>)
  const user = userEvent.setup()
  expect(await screen.findByRole('checkbox', { name: 'Enable builds on this computer' })).not.toBeChecked()
  expect(screen.getByText('Remote execution disabled on Main')).toBeVisible()
  await user.click(screen.getByRole('checkbox', { name: 'Enable builds on this computer' }))
  const priority = screen.getByRole('spinbutton', { name: 'Build priority' })
  await user.clear(priority)
  await user.type(priority, '100')
  await user.click(screen.getByRole('button', { name: 'Save build settings' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ target, expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
  await screen.findByText('Changes saved to the server')
  rendered.unmount()
  render(<QueryClientProvider client={new QueryClient()}><BuildComputerParticipation target={target} /></QueryClientProvider>)
  expect(await screen.findByRole('checkbox', { name: 'Enable builds on this computer' })).toBeChecked()
  expect(screen.getByRole('spinbutton', { name: 'Build priority' })).toHaveValue(100)
})
it('preserves edits and reports a failed save without claiming persistence', async () => {
  clearRevisionedFormPersistence()
  server.use(http.post('*/api/management/settings/build-computers/read', () => HttpResponse.json({
    preference: { target, revision: 0, buildEnabled: false, buildPriority: 50 }, state: 'disabled',
    reasons: [], remoteExecutionEnabled: true,
  })), http.post('*/api/management/settings/build-computers/update', () => HttpResponse.json({
    error: { code: 'ACCESS_DENIED', message: 'Settings permission is required.' },
  }, { status: 403 })))
  render(<QueryClientProvider client={new QueryClient()}><BuildComputerParticipation target={target} /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: 'Enable builds on this computer' }))
  await user.click(screen.getByRole('button', { name: 'Save build settings' }))
  expect(await screen.findByText('Changes were not saved')).toBeVisible()
  expect(screen.getByRole('checkbox', { name: 'Enable builds on this computer' })).toBeChecked()
  expect(screen.queryByText('Changes saved to the server')).not.toBeInTheDocument()
})
