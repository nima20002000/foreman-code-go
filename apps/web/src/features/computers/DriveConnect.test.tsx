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

  it.each([500, 503])('shows temporary polling errors (%s) with status retry and restart controls', async code => {
    server.use(
      http.post('/api/management/computers/drive/connect', () => HttpResponse.json(waiting)),
      http.post('/api/management/computers/drive/connect/status', () => HttpResponse.json({ error: {
        code: 'COMPUTER_OFFLINE', message: 'Google sign-in status is temporarily unavailable.',
      } }, { status: code })),
    )
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Drive' }))
    expect(await screen.findByText('Google sign-in status is temporarily unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry status' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument()
    expect(screen.getByLabelText('Authorization result')).toBeInTheDocument()
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


describe('Drive recovery and overlapping user intents', () => {
  it.each([403, 404])('stops terminal %s polling and offers cancel or restart', async status => {
    server.use(
      http.post('/api/management/computers/drive/connect', () => HttpResponse.json(waiting)),
      http.post('/api/management/computers/drive/connect/status', () => HttpResponse.json({ error: {
        code: status === 403 ? 'FORBIDDEN' : 'DRIVE_LOGIN_NOT_FOUND', message: 'Sign-in access is unavailable.',
      } }, { status })),
    )
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Drive' }))
    expect(await screen.findByText('Sign-in access is unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry status' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Authorization result')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each(['disconnect-first', 'start-first'])('keeps the account switch as the last intent when %s responds', async order => {
    let releaseDisconnect!: () => void
    let releaseStart!: () => void
    const disconnectGate = new Promise<void>(resolve => { releaseDisconnect = resolve })
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    let state = waiting
    let disconnectEntered = false
    let startEntered = false
    server.use(
      http.post('/api/management/computers/drive/disconnect', async () => {
        disconnectEntered = true
        await disconnectGate
        return HttpResponse.json(disconnected)
      }),
      http.post('/api/management/computers/drive/connect', async () => {
        startEntered = true
        await startGate
        return HttpResponse.json(waiting)
      }),
      http.post('/api/management/computers/drive/connect/status', () => HttpResponse.json(state)),
      http.post('/api/management/computers/drive/connect/complete', () => {
        state = { ...waiting, state: 'connected', account: 'new@gmail.com' }
        return HttpResponse.json(state)
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    useComputerUi.getState().openDrive(`${mainId}:main`)
    render(<QueryClientProvider client={client}><DriveConnectDialog target={target} name="Main"
      account={{ tool: 'drive', installed: true, signedIn: true, account: 'old@gmail.com', details: [] }} /></QueryClientProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(disconnectEntered).toBe(true))
    expect(screen.getByRole('button', { name: 'Switch account' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
    await waitFor(() => expect(startEntered).toBe(true))
    if (order === 'disconnect-first') {
      await act(async () => releaseDisconnect())
      await act(async () => releaseStart())
    } else {
      await act(async () => releaseStart())
      fireEvent.change(await screen.findByLabelText('Authorization result'), { target: { value: 'new-authorization' } })
      fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
      await screen.findByText('new@gmail.com')
      await act(async () => releaseDisconnect())
    }
    if (order === 'disconnect-first') {
      fireEvent.change(await screen.findByLabelText('Authorization result'), { target: { value: 'new-authorization' } })
      fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
    }
    expect(await screen.findByText('new@gmail.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch account' })).toBeInTheDocument()
  })
})
