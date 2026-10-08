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
