import { act, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { HarnessStatusMenu } from './HarnessStatusMenu'
import { useNavigationUiStore } from '../workspaces/navigationUiStore'
import { getMockAgentDefaults } from '../../shared/mocks/scenarios'

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')

function mockRelocation() {
  const cancel = vi.fn()
  const animate = vi.fn(() => ({ cancel }))
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  vi.spyOn(HTMLAnchorElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLAnchorElement) {
    const index = Array.from(this.parentElement!.children).indexOf(this)
    const { collapsed, width } = useNavigationUiStore.getState()
    return new DOMRect(collapsed ? 0 : 10 + index * width / 3, collapsed ? index * 34 : 0, 40, 32)
  })
  return { animate, cancel }
}

describe('HarnessStatusMenu', () => {
  afterEach(() => {
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  })
  it.each([
    ['eligible', 'Available'], ['blocked', 'Unavailable'], ['unverified', 'Unverified'],
  ])('shows %s as an accessible status with the matching light', async (status, label) => {
    server.use(http.get('/api/management/harnesses/:harness/execution-readiness', ({ params, request }) => HttpResponse.json({
      harness: params.harness, scope: new URL(request.url).searchParams.get('scope'), status, rolloutEnabled: true,
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

  it('checks the selected Claude Operator profile separately from the workflow preset', async () => {
    const defaults = getMockAgentDefaults()
    const requests: string[] = []
    server.use(http.get('/api/management/settings/agents', () => HttpResponse.json({ ...defaults, revision: 4,
      value: { ...defaults.value, operator: { ...defaults.value.operator, harness: { harness: 'claude', model: 'native-model', effort: 'medium',
        authMode: 'subscription', configDirectory: '/unit/profile', permissionMode: 'default', sandbox: 'danger-full-access',
        tools: [], permissionRules: [], instructions: '', mcpServers: {} } } } })),
    http.get('/api/management/harnesses/:harness/execution-readiness', ({ params, request }) => {
      const scope = new URL(request.url).searchParams.get('scope')!
      requests.push(`${params.harness}:${scope}`)
      return HttpResponse.json({ harness: params.harness, scope, status: 'eligible', rolloutEnabled: true,
        defaultsRevision: 4, checkedAt: new Date().toISOString(), reason: null, limitation: 'Exact current profile.' })
    }))
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('link', { name: 'Claude: Available' })).toHaveAttribute('title', expect.stringContaining('Operator default'))
    expect(await screen.findByRole('link', { name: 'Codex: Available' })).toHaveAttribute('title', expect.stringContaining('Workflow preset'))
    expect(requests).toContain('claude:operator-configuration')
    expect(requests).not.toContain('claude:saved-harness-defaults')
  })

  it.each([
    ['HARNESS_PROFILE_REQUIRED', 'Setup required'],
    ['CLAUDE_NATIVE_QUALIFICATION_UNAVAILABLE', 'Not qualified'],
  ])('explains the blocked Claude reason %s without implying installation is missing', async (code, label) => {
    server.use(http.get('/api/management/harnesses/:harness/execution-readiness', ({ params, request }) => HttpResponse.json({
      harness: params.harness, scope: new URL(request.url).searchParams.get('scope'), status: params.harness === 'claude' ? 'blocked' : 'eligible', rolloutEnabled: true,
      defaultsRevision: code === 'HARNESS_PROFILE_REQUIRED' ? null : 1, checkedAt: new Date().toISOString(),
      reason: params.harness === 'claude' ? { code, message: 'Claude needs the exact saved profile and native proof.' } : null,
      limitation: 'Saved defaults only.',
    })))
    renderWithRouter(<HarnessStatusMenu />)
    const link = await screen.findByRole('link', { name: `Claude: ${label}` })
    expect(link).toHaveAttribute('title', expect.stringContaining('exact saved profile'))
    expect(link.querySelector('.harness-status-light')).toHaveClass('harness-status-light--blocked')
    expect(await screen.findByRole('link', { name: 'Codex: Available' })).toBeVisible()
  })

  it('animates manual relocation with transform/opacity and cancels it for instant keyboard changes', async () => {
    const { animate, cancel } = mockRelocation()
    renderWithRouter(<HarnessStatusMenu />)
    await screen.findByRole('navigation', { name: 'Harness availability' })
    expect(animate).not.toHaveBeenCalled()
    act(() => useNavigationUiStore.getState().setCollapsed(true, 'manual'))
    expect(animate).toHaveBeenCalledTimes(3)
    expect(animate).toHaveBeenCalledWith([
      { transform: expect.stringContaining('translate('), opacity: 0.75 },
      { transform: 'translate(0, 0)', opacity: 1 },
    ], { duration: 160, easing: 'cubic-bezier(0.22, 0, 0, 1)' })
    act(() => useNavigationUiStore.getState().setCollapsed(false))
    expect(cancel).toHaveBeenCalledTimes(3)
    expect(animate).toHaveBeenCalledTimes(3)
    act(() => useNavigationUiStore.getState().setWidth(300))
    expect(animate).toHaveBeenCalledTimes(3)
  })

  it('keeps manual relocation instant when reduced motion is requested', async () => {
    const { animate } = mockRelocation()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    try {
      renderWithRouter(<HarnessStatusMenu />)
      await screen.findByRole('navigation', { name: 'Harness availability' })
      act(() => useNavigationUiStore.getState().setCollapsed(true, 'manual'))
      expect(animate).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
