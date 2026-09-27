import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { redactKnownSecrets, redactSecretText } from '../src/modules/harnesses/secrets.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { ManagedOpenCodeServer, type OpenCodeServerController } from '../src/modules/harnesses/opencodeTransport.js'

describe('ENG-03 concurrent native event redaction', () => {
  it('preserves nested, key, and JSON-escaped secret redaction without changing the input', () => {
    const secret = 'sk-test-' + 'A'.repeat(72)
    const source = { [secret]: [{ text: secret, nested: { encoded: JSON.stringify([secret]) } }], safe: null }
    const before = structuredClone(source)
    const redacted = redactKnownSecrets(source, [secret, '', secret])
    expect(redacted).toEqual({ '[REDACTED]': [{ text: '[REDACTED]', nested: { encoded: '["[REDACTED]"]' } }], safe: null })
    expect(source).toEqual(before)
    expect(redactSecretText(JSON.stringify({ value: secret }), [secret])).toBe('{"value":"[REDACTED]"}')
    expect(redactSecretText(String.raw`{"token":"\u0073ecret"}`, ['secret']))
      .toBe('{"token":"[REDACTED]"}')
    expect(redactSecretText(String.raw`{"\u0073ecret":"safe"}`, ['secret']))
      .toBe('{"[REDACTED]":"safe"}')
  })

  it('keeps a large nested native payload below the event-loop blocking budget', async () => {
    const secret = 'sk-test-' + 'A'.repeat(72)
    const password = 'opaque-password-' + 'B'.repeat(48)
    const payload = { messages: Array.from({ length: 10_000 }, (_, index) => ({
      info: { id: `message-${index}`, role: 'assistant', time: { created: index, completed: index + 1 } },
      parts: [
        { type: 'text', text: `n=${index} value=${index * index} ${index % 97 === 0 ? secret : 'ordinary text'}` },
        { type: 'step-start', snapshot: JSON.stringify({ secret: index % 113 === 0 ? password : 'safe' }) },
      ],
    })) }
    const started = performance.now()
    const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 0))
    const result = redactKnownSecrets(payload, [secret, password, '', secret])
    const eventLoopDelayMs = await timer
    expect(result.messages).toHaveLength(10_000)
    expect(result.messages[0]?.parts[0]?.text).toContain('[REDACTED]')
    expect(result.messages[0]?.parts[1]?.snapshot).toContain('[REDACTED]')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(password)
    expect(eventLoopDelayMs).toBeLessThan(750)
  })

  it('redacts accumulated and current OpenCode credentials plus server password in one native event pass', () => {
    const current = 'current-token-' + 'A'.repeat(64)
    const previous = 'previous-token-' + 'B'.repeat(64)
    const password = 'server-password-' + 'C'.repeat(48)
    const basic = Buffer.from(`opencode:${password}`).toString('base64')
    const server = new ManagedOpenCodeServer({ binary: '/bin/false', workingDirectory: '/tmp',
      ownerAgentId: 'test-agent', environment: { agentId: 'test-agent', variables: { GRAPHQL_MCP_TOKEN: current } } })
    Reflect.set(server, 'password', password)
    const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'test-agent' })
    const knownSecrets = Reflect.get(manager, 'knownSecrets') as Set<string>
    knownSecrets.add(previous)
    const payload = { [current]: [{ text: previous, nested: JSON.stringify({ current, password, basic }) }] }
    const actual = Reflect.get(manager, 'sanitize').call(manager, payload) as unknown
    expect(actual).toEqual(redactKnownSecrets(payload, [previous, current, password, basic]))
    for (const secret of [previous, current, password, basic]) expect(JSON.stringify(actual)).not.toContain(secret)

    // Custom transports without the combined method keep both original scopes.
    const custom = { ownerAgentId: 'test-agent', redact: <T>(value: T) => redactKnownSecrets(value, [current]),
      redactWithAdditionalSecrets: <T>(value: T) => value } as unknown as OpenCodeServerController
    const fallback = new OpenCodeNativeSessionManager({ server: custom, ownerAgentId: 'test-agent' })
    ;(Reflect.get(fallback, 'knownSecrets') as Set<string>).add(previous)
    const fallbackResult = Reflect.get(fallback, 'sanitize').call(fallback, { current, previous }) as unknown
    expect(fallbackResult).toEqual({ current: '[REDACTED]', previous: '[REDACTED]' })
  })

  it('bounds combined OpenCode event redaction against one equivalent payload traversal', () => {
    const current = 'current-token-' + 'A'.repeat(64)
    const previous = 'previous-token-' + 'B'.repeat(64)
    const server = new ManagedOpenCodeServer({ binary: '/bin/false', workingDirectory: '/tmp',
      ownerAgentId: 'test-agent', environment: { agentId: 'test-agent', variables: { GRAPHQL_MCP_TOKEN: current } } })
    const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'test-agent' })
    ;(Reflect.get(manager, 'knownSecrets') as Set<string>).add(previous)
    const payload = { messages: Array.from({ length: 10_000 }, (_, index) => ({
      info: { id: `message-${index}`, role: 'assistant', time: { created: index, completed: index + 1 } },
      parts: [
        { type: 'text', text: `n=${index} ${index % 97 === 0 ? current : 'ordinary text'}` },
        { type: 'step-start', snapshot: JSON.stringify({ secret: index % 113 === 0 ? previous : 'safe' }) },
      ],
    })) }
    const baselineStart = performance.now()
    const baseline = redactKnownSecrets(payload, [previous, current])
    const baselineMs = performance.now() - baselineStart
    const actualStart = performance.now()
    const actual = Reflect.get(manager, 'sanitize').call(manager, payload) as unknown
    const actualMs = performance.now() - actualStart
    expect(actual).toEqual(baseline)
    expect(actualMs).toBeLessThan(baselineMs * 1.5 + 40)
  })
})
