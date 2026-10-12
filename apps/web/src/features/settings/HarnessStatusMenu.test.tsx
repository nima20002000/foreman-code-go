import { vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { HarnessStatusMenu } from './HarnessStatusMenu'
import { useNavigationUiStore } from '../workspaces/navigationUiStore'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'
import { computerSettingsKeys } from '../../shared/api/computerSettings'
import { HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'

const mainId = mockRuntimeIdentity.installationId
const host = { kind: 'main', mainId } as const
const inventoryKey = () => computerSettingsKeys.inventory(host, mainId)
function inventory(installed = true) {
  return HarnessRegistryReadbackSchema.parse({
    instances: [],
    installations: ['codex', 'claude'].map(driverId => ({
      hostRef: host, driverId, driverRevision: '1', protocolRevision: 'native',
      harnessInstallationId: `${driverId}-installation`, installationFingerprint: 'payload',
      environmentGeneration: 'environment', connectionGeneration: 'connection',
      observedVersion: null, installed, authenticated: null, compatible: null, qualified: null,
      launcher: { requested: driverId, resolvedLauncher: installed ? `/recorded/${driverId}` : null,
        fingerprint: 'payload', status: installed ? 'installed' : 'missing', interpreter: null, diagnostics: [],
        environment: { generation: 'environment', provenance: 'terminal', cwd: '/recorded', path: '/recorded' },
        checkedAt: '2026-10-09T00:00:00.000Z' },
    })),
    hostMetadata: { hostRef: host, applicationInstallationId: mainId, connection: null,
      platform: null, workspaceRoots: null },
  })
}

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
    [true, 'Installed', 'installed'], [false, 'Not installed', 'missing'],
  ] as const)('shows installed=%s from inventory with an accessible status and matching light', async (installed, label, state) => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json(inventory(installed))))
    renderWithRouter(<HarnessStatusMenu />)
    for (const name of ['Codex', 'Claude']) {
      const link = await screen.findByRole('button', { name: `${name}: ${label}` })
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      fireEvent.click(link, { ctrlKey: true })
      expect(open).toHaveBeenCalledWith(expect.stringContaining(`/settings/harnesses?harness=${name.toLowerCase()}`), '_blank')
      open.mockRestore()
      expect(link.querySelector('.harness-status-light')).toHaveClass(`harness-status-light--${state}`)
      expect(link).toHaveAttribute('title', expect.stringContaining('profile qualification are checked separately'))
    }
  })

  it('recognizes installed harnesses without slow or failed preset and Operator profile checks', async () => {
    const inspect = vi.fn(() => HttpResponse.json({ error: { code: 'HARNESS_CHECK_TIMEOUT', message: 'Timed out.' } }, { status: 503 }))
    server.use(
      http.get('/api/management/harnesses/registry', () => HttpResponse.json(inventory())),
      http.get('/api/management/harnesses/:harness/execution-readiness', inspect),
      http.get('/api/management/settings/agents', inspect),
      http.get('/api/management/harnesses', inspect),
    )
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('button', { name: 'Codex: Installed' })).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Claude: Installed' })).toBeVisible()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('shows an unverified status when inventory cannot be read', async () => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.error()))
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('button', { name: 'Codex: Unverified' }))
      .toHaveAttribute('title', expect.stringContaining('Could not read installation status'))
  })

  it('keeps absent observations unverified instead of assuming a harness is missing', async () => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json({ instances: [], installations: [] })))
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('button', { name: 'Claude: Unverified' }))
      .toHaveAttribute('title', expect.stringContaining('No installation inventory'))
  })

  it('does not display another Main computer inventory', async () => {
    const wrong = inventory()
    wrong.installations[0]!.hostRef.mainId = '11111111-1111-4111-8111-111111111111'
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json(wrong)))
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('button', { name: 'Codex: Unverified' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Codex: Installed' })).not.toBeInTheDocument()
  })

  it('reuses the shared inspection while a background refresh runs and displays a confirmed removal', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const read = vi.fn(async () => {
      await gate
      return HttpResponse.json(inventory(false))
    })
    server.use(http.get('/api/management/harnesses/registry', read))
    const { queryClient } = renderWithRouter(<HarnessStatusMenu />)
    queryClient.setQueryData(inventoryKey(), inventory())
    expect(await screen.findByRole('button', { name: 'Codex: Installed' })).toBeVisible()
    expect(read).not.toHaveBeenCalled()
    let refresh!: Promise<void>
    act(() => { refresh = queryClient.invalidateQueries({ queryKey: inventoryKey() }) })
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Codex: Installed' })).toBeVisible()
    await act(async () => { finish(); await refresh })
    expect(await screen.findByRole('button', { name: 'Codex: Not installed' })).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Claude: Not installed' })).toBeVisible()
  })

  it('retains the last installed observation when refreshing fails, without calling it missing', async () => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.error()))
    const { queryClient } = renderWithRouter(<HarnessStatusMenu />)
    queryClient.setQueryData(inventoryKey(), inventory())
    await screen.findByRole('button', { name: 'Codex: Installed' })
    await act(async () => { await queryClient.invalidateQueries({ queryKey: inventoryKey() }) })
    expect(await screen.findByRole('button', { name: 'Codex: Unverified' }))
      .toHaveAttribute('title', expect.stringContaining('Last inventory confirmed installation'))
    expect(screen.queryByRole('button', { name: 'Codex: Not installed' })).not.toBeInTheDocument()
  })

  it('refreshes changed inventory automatically while the sidebar stays mounted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let installed = true
    const read = vi.fn(() => HttpResponse.json(inventory(installed)))
    server.use(http.get('/api/management/harnesses/registry', read))
    const { queryClient, unmount } = renderWithRouter(<HarnessStatusMenu />)
    try {
      await screen.findByRole('button', { name: 'Codex: Installed' })
      expect(read).toHaveBeenCalledOnce()
      installed = false
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(await screen.findByRole('button', { name: 'Codex: Not installed' })).toBeVisible()
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      unmount()
      queryClient.clear()
      vi.useRealTimers()
    }
  })

  it('animates manual relocation with transform/opacity and cancels it for instant keyboard changes', async () => {
    const { animate, cancel } = mockRelocation()
    renderWithRouter(<HarnessStatusMenu />)
    await screen.findByRole('navigation', { name: 'Harness availability' })
    expect(animate).not.toHaveBeenCalled()
    act(() => useNavigationUiStore.getState().setCollapsed(true, 'manual'))
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenCalledWith([
      { transform: expect.stringContaining('translate('), opacity: 0.75 },
      { transform: 'translate(0, 0)', opacity: 1 },
    ], { duration: 160, easing: 'cubic-bezier(0.22, 0, 0, 1)' })
    act(() => useNavigationUiStore.getState().setCollapsed(false))
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenCalledTimes(2)
    act(() => useNavigationUiStore.getState().setWidth(300))
    expect(animate).toHaveBeenCalledTimes(2)
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
