import { describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES } from '@graphql/contracts'
import { ApiClient } from './client'

function fixture() {
  const interaction = { ...NATIVE_INTERACTION_FIXTURES.codex, approval: { handler: 'user' as const } }
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => new Response(JSON.stringify(
    options?.method === 'POST' ? { interaction, replayed: false } : { interaction, canRespond: true },
  ), { status: 200, headers: { 'content-type': 'application/json' } }))
  return { interaction, fetcher, client: new ApiClient({ baseUrl: 'http://localhost', fetch: fetcher }) }
}

describe('PR17 explicit User approval HTTP boundary', () => {
  it('uses the signed-in browser session without a second bearer', async () => {
    const { interaction, client, fetcher } = fixture()
    const result = await client.getUserInteraction(interaction.id)
    expect(result.canRespond).toBe(true)
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`http://localhost/api/user/interactions/${encodeURIComponent(interaction.id)}`)
    expect(options?.credentials).toBe('same-origin')
    expect(new Headers(options?.headers).has('Authorization')).toBe(false)
  })

  it('keeps an explicitly supplied User bearer isolated from browser cookies', async () => {
    const { interaction, client, fetcher } = fixture()
    const result = await client.getUserInteraction(interaction.id, 'fixture-human-token', { credentials: 'include' })
    expect(result.canRespond).toBe(true)
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`http://localhost/api/user/interactions/${encodeURIComponent(interaction.id)}`)
    expect(options?.credentials).toBe('omit')
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-human-token')
  })

  it('posts the exact request and choice identities to the User response route', async () => {
    const { interaction, client, fetcher } = fixture()
    const input = { interactionId: interaction.id, optionId: interaction.responseOptions[0]!.optionId, expectedRevision: interaction.revision }
    await client.respondToUserInteraction('fixture-human-token', input)
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`http://localhost/api/user/interactions/${encodeURIComponent(interaction.id)}/respond`)
    expect(options?.method).toBe('POST')
    expect(options?.credentials).toBe('omit')
    expect(JSON.parse(String(options?.body))).toEqual(input)
    expect(String(url)).not.toContain('fixture-human-token')
  })

  it('rejects malformed explicitly supplied tokens', () => {
    const { interaction, client, fetcher } = fixture()
    expect(() => client.getUserInteraction(interaction.id, '')).toThrow()
    expect(() => client.getUserInteraction(interaction.id, 'Bearer token-with-prefix')).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
