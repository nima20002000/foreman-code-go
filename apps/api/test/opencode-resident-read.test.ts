import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeTransport.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function resident() {
  const server = new ManagedOpenCodeServer({ binary: '/unused-fixture-binary', workingDirectory: '/work', ownerAgentId: 'owner' })
  const state = server as unknown as { child: { exitCode: number | null; signalCode: string | null }; baseUrl: string; password: string; epoch: number }
  state.child = { exitCode: null, signalCode: null }
  state.baseUrl = 'http://127.0.0.1:3001'
  state.password = 'fixture-only-password'
  server.generation = 4
  return { server, state }
}
it('resident inspection cannot spawn, ensure, recover, or expand beyond bounded permission/ancestry GETs', async () => {
  const { server } = resident()
  const ensure = vi.spyOn(server, 'ensure').mockRejectedValue(new Error('Inspection attempted startup'))
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'GET')
    assert.equal(new Headers(init?.headers).has('authorization'), true)
    return new Response('[]')
  })
  vi.stubGlobal('fetch', fetch)
  assert.equal(server.residentGeneration, 4)
  const response = await server.requestResident('/permission?directory=%2Fwork', new AbortController().signal, 4)
  assert.equal(response?.status, 200)
  await response?.body?.cancel()
  assert.equal(await server.requestResident('/mcp?directory=%2Fwork', new AbortController().signal, 4), undefined)
  assert.equal(await server.requestResident('/permission?directory=%2Fwork', new AbortController().signal, 3), undefined)
  assert.equal(ensure.mock.calls.length, 0)
  assert.equal(fetch.mock.calls.length, 1)
})
it('never starts an absent resident', async () => {
  const server = new ManagedOpenCodeServer({ binary: '/unused-fixture-binary', workingDirectory: '/work', ownerAgentId: 'owner' })
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  assert.equal(server.residentGeneration, undefined)
  assert.equal(await server.requestResident('/permission', new AbortController().signal, 0), undefined)
  assert.equal(fetch.mock.calls.length, 0)
})
it('discards and cancels a late read when resident process/generation/owner epoch is replaced', async () => {
  for (const change of ['exit', 'generation', 'epoch'] as const) {
    const { server, state } = resident()
    let finish!: (response: Response) => void
    let canceled = false
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finish = resolve }))
    const pending = server.requestResident('/permission?directory=%2Fwork', new AbortController().signal, 4)
    if (change === 'exit') state.child.exitCode = 0
    if (change === 'generation') server.generation++
    if (change === 'epoch') state.epoch++
    finish(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true } })))
    assert.equal(await pending, undefined)
    assert.equal(canceled, true)
  }
})
