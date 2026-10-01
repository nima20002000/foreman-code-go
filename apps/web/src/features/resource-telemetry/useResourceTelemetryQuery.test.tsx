import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { telemetrySelectorKey, type TelemetryReadResult, type TelemetrySelector } from '@graphql/contracts/resource-telemetry'
import { resourceTelemetryFixtures as fixtures, telemetryComputerFixture, telemetryOwnedFixture, telemetrySelectionRaceFixture } from '@graphql/contracts/resource-telemetry-fixtures'
import { delay, http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { resourceTelemetryKeys, useResourceTelemetryQuery } from '../../shared/api/resourceTelemetry'
import { beginSessionChange, finishSessionChange, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { ScopedResourceTelemetry } from './ResourceTelemetryCards'

const route = '*/api/management/resource-telemetry/read'
let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const fresh = () => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) }
const keyOf = (selector: TelemetrySelector) => telemetrySelectorKey(selector)
const noSample = (selector: TelemetrySelector): TelemetryReadResult => ({ kind: 'no-sample', selector, selectorKey: keyOf(selector), reason: 'not-yet-sampled', identity: null })
/** Re-addresses a fixture sample to another selector so the shared selector-key invariant still holds. */
const forSelector = (result: TelemetryReadResult, selector: TelemetrySelector): TelemetryReadResult => result.kind !== 'sample' ? result
  : { kind: 'sample', sample: { ...result.sample, selector, selectorKey: keyOf(selector) }, lastKnown: null }

afterEach(() => { cleanup(); client?.clear(); if (sessionIsSwitching()) finishSessionChange() })

describe('useResourceTelemetryQuery', () => {
  it('POSTs the full selector and returns the validated fresh zero reading', async () => {
    fresh()
    let body: unknown
    server.use(http.post(route, async ({ request }) => { body = await request.json(); return HttpResponse.json(fixtures.freshZero) }))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('sample'))
    expect(body).toEqual(JSON.parse(JSON.stringify(telemetryOwnedFixture)))
    expect(result.current.data?.selectorKey).toBe(keyOf(telemetryOwnedFixture))
    expect(result.current.data?.receivedMonoMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects a response that belongs to another selection', async () => {
    fresh()
    const other = { ...telemetryOwnedFixture, attributionRevision: '2' }
    server.use(http.post(route, () => HttpResponse.json(fixtures.freshZero)))
    const { result } = renderHook(() => useResourceTelemetryQuery(other), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('rejects a no-sample response whose selector disagrees with its selected key', async () => {
    fresh()
    const other = { ...telemetryOwnedFixture, attributionRevision: '2' }
    server.use(http.post(route, () => HttpResponse.json({ ...noSample(other), selectorKey: keyOf(telemetryOwnedFixture) })))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('maps HTTP 403 to a caller denial without values', async () => {
    fresh()
    server.use(http.post(route, () => HttpResponse.json(fixtures.denied, { status: 403 })))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('denied'))
  })

  it('replaces a previously authorized value with caller denial on refresh', async () => {
    fresh()
    server.use(http.post(route, () => HttpResponse.json(fixtures.freshZero)))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('sample'))
    server.use(http.post(route, () => HttpResponse.json(fixtures.denied, { status: 403 })))
    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.data?.result).toEqual(fixtures.denied))
    expect(client.getQueryData(resourceTelemetryKeys.read(keyOf(telemetryOwnedFixture)))).toMatchObject({ result: fixtures.denied })
  })

  it('clears private readings during a session change and reads again only after it finishes', async () => {
    fresh()
    let requests = 0
    server.use(http.post(route, () => { requests += 1; return HttpResponse.json(fixtures.freshZero) }))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('sample'))
    await act(async () => { beginSessionChange() })
    expect(result.current.data).toBeUndefined()
    expect(client.getQueriesData({ queryKey: resourceTelemetryKeys.root }).every(([, value]) => value === undefined)).toBe(true)
    expect(requests).toBe(1)
    server.use(http.post(route, () => { requests += 1; return HttpResponse.json(fixtures.denied, { status: 403 }) }))
    await act(async () => { finishSessionChange() })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('denied'))
    expect(requests).toBe(2)
  })

  it('aborts an in-flight read when its Info surface unmounts', async () => {
    fresh()
    let signal: AbortSignal | undefined
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(route, async ({ request }) => { signal = request.signal; await pending; return HttpResponse.json(fixtures.freshZero) }))
    const view = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(signal).toBeDefined())
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { release(); await pending })
    expect(client.getQueryData(resourceTelemetryKeys.read(keyOf(telemetryOwnedFixture)))).toBeUndefined()
  })

  it('rejects an earlier session read that resolves after a session change', async () => {
    fresh()
    let signal: AbortSignal | undefined
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(route, async ({ request }) => { signal = request.signal; await pending; return HttpResponse.json(fixtures.freshZero) }))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(signal).toBeDefined())
    await act(async () => { beginSessionChange(); release(); await pending })
    expect(signal?.aborted).toBe(true)
    expect(result.current.data).toBeUndefined()
    expect(client.getQueriesData({ queryKey: resourceTelemetryKeys.root }).every(([, value]) => value === undefined)).toBe(true)
  })

  it('does not query without a selector', () => {
    fresh()
    const { result } = renderHook(() => useResourceTelemetryQuery(undefined), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.data).toBeUndefined()
  })

  it('ignores late A and B responses after A→B→A, even on revisit', async () => {
    fresh()
    const [a1, b, a2] = telemetrySelectionRaceFixture
    let aRequests = 0
    let bRequests = 0
    server.use(http.post(route, async ({ request }) => {
      const selector = await request.json() as TelemetrySelector
      if (keyOf(selector) === keyOf(b!.selector as TelemetrySelector)) { bRequests += 1; await delay(b!.delayMs); return HttpResponse.json(noSample(selector)) }
      aRequests += 1
      if (aRequests === 1) { await delay(a1!.delayMs); return HttpResponse.json(a1!.response) }
      await delay(a2!.delayMs)
      return HttpResponse.json(a2!.response)
    }))
    const initialProps: { selector: TelemetrySelector } = { selector: a1!.selector }
    const { result, rerender } = renderHook(({ selector }: { selector: TelemetrySelector }) => useResourceTelemetryQuery(selector), { wrapper, initialProps })
    await waitFor(() => expect(aRequests).toBe(1))
    rerender({ selector: b!.selector as TelemetrySelector })
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(bRequests).toBe(1))
    rerender({ selector: a2!.selector })
    await waitFor(() => expect(result.current.data?.result).toEqual(a2!.response))
    // The first A response (300 ms) and the B response (100 ms) land later and must not replace the revisit.
    await delay(400)
    expect(result.current.data?.selectorKey).toBe(keyOf(a2!.selector))
    expect(result.current.data?.result.kind).toBe('no-sample')
  })

  it('keeps two nodes of the same Agent on separate selector keys and readings', async () => {
    fresh()
    const node2 = { ...telemetryOwnedFixture, owner: { ...telemetryOwnedFixture.owner, nodeId: 'node-2' } } as TelemetrySelector
    expect(keyOf(node2)).not.toBe(keyOf(telemetryOwnedFixture))
    server.use(http.post(route, async ({ request }) => {
      const selector = await request.json() as TelemetrySelector
      return HttpResponse.json(keyOf(selector) === keyOf(node2) ? forSelector(fixtures.warmup!, node2) : fixtures.freshZero)
    }))
    const one = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    const two = renderHook(() => useResourceTelemetryQuery(node2), { wrapper })
    await waitFor(() => expect(one.result.current.data && two.result.current.data).toBeTruthy())
    expect(one.result.current.data?.selectorKey).toBe(keyOf(telemetryOwnedFixture))
    expect(two.result.current.data?.selectorKey).toBe(keyOf(node2))
    expect(two.result.current.data?.result).not.toEqual(one.result.current.data?.result)
  })
})

describe('ScopedResourceTelemetry', () => {
  const context = { phase: 'observed', computerName: 'Main computer', computerId: telemetryComputerFixture.host.deviceId } as const

  it('shows context, whole computer and execution scopes separately', async () => {
    fresh()
    server.use(http.post(route, async ({ request }) => {
      const selector = await request.json() as TelemetrySelector
      return HttpResponse.json(selector.scope === 'computer' ? fixtures.computerZero : fixtures.freshZero)
    }))
    render(<ScopedResourceTelemetry context={context} computerSelector={telemetryComputerFixture as Extract<TelemetrySelector, { scope: 'computer' }>} ownedSelector={telemetryOwnedFixture} />, { wrapper })
    expect(screen.getByText('Execution observed on')).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Computer' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Execution' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('0.0%')).toHaveLength(2))
  })

  it('labels the live computer reading "Computer now" in history and never shows it as the Run metrics', async () => {
    fresh()
    server.use(http.post(route, () => HttpResponse.json(fixtures.computerZero)))
    render(<ScopedResourceTelemetry mode="historical" context={{ ...context, phase: 'accepted' }}
      computerSelector={telemetryComputerFixture as Extract<TelemetrySelector, { scope: 'computer' }>} ownedSelector={telemetryOwnedFixture} />, { wrapper })
    expect(await screen.findByRole('region', { name: 'Computer now' })).toBeInTheDocument()
    expect(screen.getByText('Historical metrics unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Execution' })).toBeNull()
  })

  it('renders a stored captured sample only as last known history', () => {
    fresh()
    render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={fixtures.freshZero} />, { wrapper })
    expect(screen.getByRole('region', { name: 'Captured execution metrics' })).toHaveTextContent('Last known · not current')
  })

  it('does not label a whole-computer sample as captured execution metrics', () => {
    fresh()
    render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={fixtures.computerZero} />, { wrapper })
    expect(screen.getByText('Historical metrics unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Captured execution metrics' })).toBeNull()
  })
})
