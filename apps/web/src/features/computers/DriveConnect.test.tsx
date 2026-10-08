import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { DriveLoginState } from '@foreman-code/contracts/computer-accounts'
import { server } from '../../mocks/server'
import { DriveConnectDialog } from './DriveConnect'
import { useComputerUi } from './computerUiStore'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

const mainId = '11111111-1111-4111-8111-111111111111'
const loginId = '22222222-2222-4222-8222-222222222222'
const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }
const waiting: DriveLoginState = { loginId, state: 'waiting', authorizationUrl: null, authorizationCommand: 'rclone authorize drive e30',
  expiresAt: '2099-01-01T00:00:00.000Z', account: null, mountPath: null, message: null }
const disconnected: DriveLoginState = { ...waiting, loginId: null, state: 'disconnected', authorizationCommand: null, expiresAt: null }
const clients: QueryClient[] = []
function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  useComputerUi.setState({ drive: { key: `${mainId}:main`, session: sessionGeneration() } })
  render(<QueryClientProvider client={client}><DriveConnectDialog target={target} name="Main" account={undefined} /></QueryClientProvider>)
  return client
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); useComputerUi.getState().closeDrive() })

describe('Drive connection dialog', () => {
  it('reconnects after disconnecting in the same dialog using authorization on the browser computer', async () => {
    let state = waiting
    server.use(
      http.post('/api/management/computers/drive/connect', () => { state = waiting; return HttpResponse.json(state) }),
      http.post('/api/management/computers/drive/connect/status', () => HttpResponse.json(state)),
      http.post('/api/management/computers/drive/disconnect', () => { state = disconnected; return HttpResponse.json(state) }),
      http.post('/api/management/computers/drive/connect/complete', async ({ request }) => {
        expect(await request.json()).toMatchObject({ target, loginId, token: 'authorization-result' })
        state = { ...waiting, state: 'connected', account: 'owner@gmail.com', mountPath: '/home/u/Foreman Code Drive' }
        return HttpResponse.json(state)
      }),
    )
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Drive' }))
    expect(await screen.findByText('rclone authorize drive e30')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Google Drive' }))
    fireEvent.change(await screen.findByLabelText('Authorization result'), { target: { value: 'authorization-result' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
    expect(await screen.findByText('owner@gmail.com')).toBeInTheDocument()
  })

  it.each([404, 503])('shows polling errors (%s) with status retry and restart controls', async code => {
    server.use(
      http.post('/api/management/computers/drive/connect', () => HttpResponse.json(waiting)),
      http.post('/api/management/computers/drive/connect/status', () => HttpResponse.json({ error: {
        code: 'DRIVE_LOGIN_NOT_FOUND', message: 'This Google sign-in is no longer active. Start again.',
      } }, { status: code })),
    )
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Drive' }))
    expect(await screen.findByText('This Google sign-in is no longer active. Start again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry status' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Authorization result')).not.toBeInTheDocument()
  })

  it('expires authorization locally when the server session is gone', async () => {
    server.use(http.post('/api/management/computers/drive/connect', () => HttpResponse.json({ ...waiting,
      expiresAt: '2000-01-01T00:00:00.000Z' })))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Drive' }))
    expect(await screen.findByText('Google sign-in expired. Start again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeInTheDocument()
  })

  it('refreshes account queries after completing a mount', async () => {
    server.use(
      http.post('/api/management/computers/drive/connect', () => HttpResponse.json(waiting)),
      http.post('/api/management/computers/drive/connect/status', () => HttpResponse.json(waiting)),
      http.post('/api/management/computers/drive/connect/complete', () => HttpResponse.json({ ...waiting, state: 'connected' })),
    )
    const cache = renderDialog()
    const key = ['computer-accounts', sessionGeneration(), mainId]
    cache.setQueryData(key, { old: true })
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Drive' }))
    fireEvent.change(await screen.findByLabelText('Authorization result'), { target: { value: 'token' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' })))
    await waitFor(() => expect(cache.getQueryState(key)?.isInvalidated).toBe(true))
  })
})
