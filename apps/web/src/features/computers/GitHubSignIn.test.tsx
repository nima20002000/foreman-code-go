import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import type { GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import { server } from '../../mocks/server'
import { GitHubSignInDialog } from './GitHubSignIn'
import { computersFixture, mainId, mainTarget } from './computersTestFixture'
import { useComputerUi } from './computerUiStore'

const waiting: GitHubLoginState = {
  loginId: '66666666-6666-4666-8666-666666666666', state: 'waiting', code: 'AB12-CD34',
  verificationUrl: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 900_000).toISOString(),
  account: null, message: null,
}
const signedOut: GitHubLoginState = { ...waiting, loginId: null, state: 'signed-out', code: null,
  verificationUrl: null, expiresAt: null }
function fixture(state = waiting, signedIn = false) {
  act(() => useComputerUi.getState().openGitHub(`${mainId}:main`))
  return computersFixture(<GitHubSignInDialog target={mainTarget} name="Main" account={{
    tool: 'github', installed: true, signedIn, account: signedIn ? 'owner' : null, details: [],
  }} />, [
    http.post('*/api/management/computers/github/login', () => HttpResponse.json(state)),
    http.post('*/api/management/computers/github/login/status', () => HttpResponse.json(state)),
    http.post('*/api/management/computers/github/logout', () => HttpResponse.json(signedOut)),
  ])
}
afterEach(() => { vi.restoreAllMocks(); act(() => useComputerUi.getState().closeGitHub()) })

it('shows signed-out after logout and starts another sign-in without the old result masking it', async () => {
  fixture({ ...waiting, state: 'signed-in', account: 'owner', code: null }, true)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeVisible()
  server.use(http.post('*/api/management/computers/github/login', () => HttpResponse.json(waiting)),
    http.post('*/api/management/computers/github/login/status', () => HttpResponse.json(waiting)))
  await user.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByText('AB12-CD34')).toBeVisible()
})

it('shows a polling failure with a status retry and restart instead of waiting forever', async () => {
  const f = fixture()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitHub' }))
  await screen.findByText('Waiting for GitHub…')
  server.use(http.post('*/api/management/computers/github/login/status', () => HttpResponse.json({
    error: { code: 'COMPUTER_OFFLINE', message: 'Computer is offline.' },
  }, { status: 409 })))
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-github-login'] }))
  expect(await screen.findByText('Computer is offline.')).toBeVisible()
  expect(screen.queryByText('Waiting for GitHub…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry status' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Start again' })).toBeVisible()
})

it('offers restart for a missing sign-in session', async () => {
  fixture()
  server.use(http.post('*/api/management/computers/github/login/status', () => HttpResponse.json({
    error: { code: 'GITHUB_LOGIN_NOT_FOUND', message: 'This sign-in is no longer active on the computer.' },
  }, { status: 404 })))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByRole('button', { name: 'Start again' })).toBeVisible()
  expect(screen.queryByText('Waiting for GitHub…')).not.toBeInTheDocument()
})

it('expires an old code even when the server still reports waiting', async () => {
  fixture({ ...waiting, expiresAt: new Date(Date.now() - 1).toISOString() })
  await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByText('The one-time code expired. Start again.')).toBeVisible()
  expect(screen.queryByText('Waiting for GitHub…')).not.toBeInTheDocument()
})

it.each(['missing', 'denied', 'success'])('gives copy feedback when Clipboard API is %s', async mode => {
  fixture()
  const user = userEvent.setup()
  const writeText = vi.fn(async () => { if (mode === 'denied') throw new Error('blocked') })
  vi.stubGlobal('navigator', { ...navigator, clipboard: mode === 'missing' ? undefined : { writeText } })
  try {
    await user.click(screen.getByRole('button', { name: 'Connect GitHub' }))
    await user.click(await screen.findByRole('button', { name: 'Copy' }))
    if (mode === 'success') {
      await waitFor(() => expect(screen.getByText('Copied. Paste it into GitHub.')).toBeVisible())
      expect(writeText).toHaveBeenCalledWith('AB12-CD34')
    } else {
      expect(await screen.findByText('Copy was blocked. Select the code and copy it manually.')).toBeVisible()
      expect(screen.getByRole('textbox', { name: 'Code to copy manually' })).toHaveValue('AB12-CD34')
    }
  } finally { vi.unstubAllGlobals() }
})


it('retries failed Git setup without requesting another login code', async () => {
  fixture({ ...waiting, state: 'git-setup-failed', account: 'owner', code: null,
    message: 'Signed in, but Git setup failed. Retry Git setup.' })
  let setups = 0
  server.use(http.post('*/api/management/computers/github/setup-git', () => {
    setups++
    return HttpResponse.json({ ...waiting, state: 'signed-in', code: null, account: 'owner' })
  }))
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByText('Signed in, but Git setup failed. Retry Git setup.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Retry Git setup' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry Git setup' })).not.toBeInTheDocument())
  expect(screen.getByText('owner')).toBeVisible()
  expect(setups).toBe(1)
})


it.each([403, 404])('treats polling HTTP %s as terminal instead of offering a status retry', async statusCode => {
  fixture()
  let polls = 0
  server.use(http.post('*/api/management/computers/github/login/status', () => {
    polls++
    return HttpResponse.json({ error: { code: statusCode === 403 ? 'ACCESS_DENIED' : 'GITHUB_LOGIN_NOT_FOUND',
      message: statusCode === 403 ? 'Access was revoked.' : 'The session was removed.' } }, { status: statusCode })
  }))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByText(statusCode === 403 ? 'Access was revoked.' : 'The session was removed.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Retry status' })).not.toBeInTheDocument()
  if (statusCode === 403) expect(screen.queryByRole('button', { name: 'Start again' })).not.toBeInTheDocument()
  else expect(screen.getByRole('button', { name: 'Start again' })).toBeVisible()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Close sign-in' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(polls).toBe(1)
})

it('expires the code after a temporary polling error without another HTTP request', async () => {
  const state = { ...waiting, expiresAt: new Date(Date.now() + 3_000).toISOString() }
  fixture(state)
  let polls = 0
  server.use(http.post('*/api/management/computers/github/login/status', () => {
    polls++
    return HttpResponse.json({ error: { code: 'COMPUTER_OFFLINE', message: 'Computer is offline.' } }, { status: 409 })
  }))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByText('Computer is offline.')).toBeVisible()
  expect(await screen.findByText('The one-time code expired. Start again.', {}, { timeout: 4_000 })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Retry status' })).not.toBeInTheDocument()
  expect(polls).toBe(1)
})

function responseGate() {
  let resolve!: (state: GitHubLoginState) => void
  const promise = new Promise<GitHubLoginState>(done => { resolve = done })
  return { promise, resolve }
}

it.each(['logout-first', 'login-first'])('keeps the last requested account switch with %s responses', async order => {
  fixture(waiting, true)
  const logout = responseGate()
  const login = responseGate()
  let logoutRequests = 0
  let loginRequests = 0
  server.use(
    http.post('*/api/management/computers/github/logout', async () => {
      logoutRequests++
      return HttpResponse.json(await logout.promise)
    }),
    http.post('*/api/management/computers/github/login', async () => {
      loginRequests++
      return HttpResponse.json(await login.promise)
    }),
  )
  const user = userEvent.setup()
  try {
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(logoutRequests).toBe(1))
    expect(screen.getByRole('button', { name: 'Switch account' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Switch account' }))
    expect(await screen.findByText('Waiting for sign-out to finish…')).toBeVisible()
    if (order === 'login-first') login.resolve(waiting)
    expect(loginRequests).toBe(0)
    await act(async () => { logout.resolve(signedOut) })
    if (order === 'logout-first') login.resolve(waiting)
    expect(await screen.findByText('AB12-CD34')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument()
    expect(loginRequests).toBe(1)
  } finally {
    logout.resolve(signedOut)
    login.resolve(waiting)
  }
})


it('keeps checking a completed device code while the computer finishes account setup', async () => {
  fixture({ ...waiting, code: null, expiresAt: new Date(Date.now() - 1).toISOString() })
  server.use(http.post('*/api/management/computers/github/login/status', () => HttpResponse.json({
    ...waiting, state: 'signed-in', code: null, account: 'owner',
  })))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByText('owner')).toBeVisible()
  expect(screen.queryByText('The one-time code expired. Start again.')).not.toBeInTheDocument()
})
