import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_SUBAGENT_CONTROL_EXPLANATION, subagentCapabilities } from '@foreman-code/contracts/subagents'
import { server } from '../../mocks/server'
import { SubagentPanel } from './SubagentPanel'
import { base, child, detail, message, receipt, scope, tool } from './testFixtures'

const clients: QueryClient[] = []
afterEach(() => { clients.forEach((client) => client.clear()); clients.length = 0 })
beforeEach(() => {
  server.use(
    http.get(`${base}/:subagentId`, () => HttpResponse.json(detail())),
    http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({ items: [], nextCursor: null, coverage: child().coverage })),
    http.get(`${base}/:subagentId/tools`, () => HttpResponse.json({ items: [tool()], nextCursor: null, coverage: child().coverage })),
  )
})
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const close = vi.fn()
  const rendered = render(<QueryClientProvider client={client}><SubagentPanel scope={scope} subagentId="child-1" onClose={close} /></QueryClientProvider>)
  return { client, close, ...rendered }
}
function qualified() {
  const capabilities = subagentCapabilities('opencode-task', '1.18.33')
  capabilities.sendInput = { support: 'supported', qualification: 'passed' }
  capabilities.interrupt = { support: 'supported', qualification: 'passed' }
  return { subagent: child({ provider: 'opencode', nativeMode: 'opencode-task', status: 'waiting', capabilities }),
    availableActions: { sendInput: true, interrupt: true, blockedReason: null } }
}
describe('Subagent panel', () => {
  it.each(['codex-multi-agent-v2', 'codex-collab'] as const)('shows %s history with explained disabled controls', async nativeMode => {
    const input = vi.fn(() => HttpResponse.json(receipt()))
    const interrupt = vi.fn(() => HttpResponse.json(receipt({ operation: 'run_subagent_interrupt_v1' })))
    const record = detail(child({ nativeMode, capabilities: subagentCapabilities(nativeMode, '0.154.0') }))
    server.use(
      http.get(`${base}/:subagentId`, () => HttpResponse.json(record)),
      http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({
        items: [message()], nextCursor: null, coverage: record.subagent.coverage,
      })),
      http.post(`${base}/:subagentId/input`, input),
      http.post(`${base}/:subagentId/interrupt`, interrupt),
    )
    mount()
    expect(await screen.findByText('Child answer')).toBeVisible()
    expect(screen.getByText(CODEX_SUBAGENT_CONTROL_EXPLANATION)).toBeVisible()
    const send = screen.getByRole('button', { name: 'Send' })
    const stop = screen.getByRole('button', { name: 'Interrupt' })
    expect(send).toBeDisabled()
    expect(stop).toBeDisabled()
    expect(send).toHaveAccessibleDescription(CODEX_SUBAGENT_CONTROL_EXPLANATION)
    expect(stop).toHaveAccessibleDescription(CODEX_SUBAGENT_CONTROL_EXPLANATION)
    fireEvent.click(send)
    fireEvent.click(stop)
    expect(input).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: /Tool calls/ }))
    expect(await screen.findByText('read_file')).toBeVisible()
  })
  it('requires native qualification and live availability independently', async () => {
    const unqualified = qualified()
    unqualified.subagent.capabilities.sendInput.qualification = 'unverified'
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(unqualified)))
    const first = mount()
    expect(await screen.findByRole('button', { name: 'Interrupt' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    first.unmount()
    const unavailable = qualified()
    unavailable.availableActions.interrupt = false
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(unavailable)))
    const second = mount()
    expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    second.unmount()
    const neither = qualified()
    neither.subagent.capabilities.sendInput.qualification = 'unverified'
    neither.availableActions.interrupt = false
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(neither)))
    mount()
    await screen.findByText("View only — OpenCode subagents can't be messaged or interrupted from here.")
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
  })
  it('allows qualified idle follow-up to a completed child when the live service advertises it', async () => {
    const record = qualified()
    record.subagent.status = 'completed'
    record.availableActions.interrupt = false
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(record)))
    mount()
    expect(await screen.findByRole('textbox', { name: 'Message to subagent' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
  })
  it('sends input with the exact read revision and treats ACK as acceptance', async () => {
    const bodies: unknown[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string; expectedRevision: string }
        bodies.push(body)
        return HttpResponse.json(receipt({ commandId: body.commandId, expectedRevision: body.expectedRevision }))
      }))
    mount()
    const input = await screen.findByRole('textbox', { name: 'Message to subagent' })
    fireEvent.change(input, { target: { value: 'Continue with evidence' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ workspaceId: scope.workspaceId, runId: scope.runId, subagentId: 'child-1', expectedRevision: '4', text: 'Continue with evidence' })
    expect(input).toHaveValue('')
  })
  it('rechecks an uncertain input using the same command identity and payload', async () => {
    const bodies: unknown[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string }
        bodies.push(body)
        return HttpResponse.json(receipt({ commandId: body.commandId, state: bodies.length === 1 ? 'uncertain' : 'acknowledged' }))
      }))
    mount()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'One command' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Check again' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
  })
  it('retains an uncertain command across closing and reopening the panel', async () => {
    const bodies: unknown[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string }
        bodies.push(body)
        return HttpResponse.json(receipt({ commandId: body.commandId, state: bodies.length === 1 ? 'uncertain' : 'acknowledged' }))
      }))
    const { client, close, rerender } = mount()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'One durable command' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Check again' })
    rerender(<QueryClientProvider client={client}><span>Closed</span></QueryClientProvider>)
    rerender(<QueryClientProvider client={client}><SubagentPanel scope={scope} subagentId="child-1" onClose={close} /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies[1]).toEqual(bodies[0])
  })
  it('reads a fresh revision after a conflict before admitting a new command', async () => {
    const record = qualified()
    const bodies: { commandId: string; expectedRevision: string }[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(record)),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string; expectedRevision: string }
        bodies.push(body)
        if (bodies.length === 1) {
          record.subagent.revision = '5'
          return HttpResponse.json({ error: { code: 'SUBAGENT_REVISION_CONFLICT', message: 'Read again' } }, { status: 409 })
        }
        return HttpResponse.json(receipt({ commandId: body.commandId, expectedRevision: body.expectedRevision }))
      }))
    mount()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'Fresh read' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies.map((body) => body.expectedRevision)).toEqual(['4', '5'])
    expect(bodies[1]?.commandId).not.toBe(bodies[0]?.commandId)
  })
  it('interrupts only through the advertised qualified action', async () => {
    let body: unknown
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/interrupt`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(receipt({ ...(body as object), operation: 'run_subagent_interrupt_v1' }))
      }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt' }))
    await screen.findByText('Interrupt delivered to the subagent.')
    expect(body).toMatchObject({ expectedRevision: '4', subagentId: 'child-1' })
    expect(body).not.toHaveProperty('text')
  })
  it('loads later transcript pages and distinguishes unavailable coverage', async () => {
    server.use(http.get(`${base}/:subagentId/messages`, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.has('cursor')
      ? { items: [message('message-2', 'Later answer')], nextCursor: null, coverage: { ...child().coverage, transcript: 'unavailable' } }
      : { items: [message()], nextCursor: 'next-page', coverage: child().coverage })))
    mount()
    await screen.findByText('Child answer')
    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }))
    await screen.findByText('Later answer')
    expect(screen.getByText("Codex doesn't share this subagent's conversation.")).toBeVisible()
    expect(screen.getByText('Child answer')).toBeVisible()
  })
  it('closes on backdrop clicks but keeps clicks and drags from inside open', async () => {
    const { close } = mount()
    const dialog = screen.getByRole('dialog')
    await screen.findByText(CODEX_SUBAGENT_CONTROL_EXPLANATION)
    const inside = screen.getByRole('tab', { name: /Messages/ })
    fireEvent.pointerDown(inside); fireEvent.click(dialog)
    expect(close).not.toHaveBeenCalled()
    fireEvent.pointerDown(inside); fireEvent.click(inside)
    expect(close).not.toHaveBeenCalled()
    fireEvent.pointerDown(dialog); fireEvent.click(dialog)
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
  })
})
