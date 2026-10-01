import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { HarnessStatusMenu } from './HarnessStatusMenu'

describe('HarnessStatusMenu', () => {
  it.each([
    ['eligible', 'Available'], ['blocked', 'Unavailable'], ['unverified', 'Unverified'],
  ])('shows %s as an accessible status with the matching light', async (status, label) => {
    server.use(http.get('/api/management/harnesses/:harness/execution-readiness', ({ params }) => HttpResponse.json({
      harness: params.harness, scope: 'saved-harness-defaults', status, rolloutEnabled: true,
      defaultsRevision: 1, checkedAt: new Date().toISOString(), reason: null, limitation: 'Saved defaults only.',
    })))
    renderWithRouter(<HarnessStatusMenu />)
    for (const name of ['Codex', 'OpenCode', 'Claude']) {
      const link = await screen.findByRole('link', { name: `${name}: ${label}` })
      expect(link).toHaveAttribute('href', expect.stringContaining(`/settings/harnesses?harness=${name.toLowerCase()}`))
      expect(link.querySelector('.harness-status-light')).toHaveClass(`harness-status-light--${status}`)
    }
  })

  it('shows an unverified status when checking fails', async () => {
    server.use(http.get('/api/management/harnesses/:harness/execution-readiness', () => HttpResponse.error()))
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('link', { name: 'Codex: Unverified' })).toHaveAttribute('title', expect.stringContaining('Could not check'))
  })
})
