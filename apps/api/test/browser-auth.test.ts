import { describe, expect, it } from 'vitest'
import { readBrowserAuthConfig } from '../src/modules/browser-auth/config.js'
import { isPublicBrowserAuthRequest } from '../src/modules/browser-auth/routes.js'
import type { FastifyRequest } from 'fastify'

const secret = 'a'.repeat(48)
describe('browser authentication configuration', () => {
  it('does not fabricate a development secret', () => {
    expect(readBrowserAuthConfig({})).toBeUndefined()
    expect(() => readBrowserAuthConfig({ BETTER_AUTH_URL: 'http://localhost:5173' })).toThrow()
    expect(() => readBrowserAuthConfig({ BETTER_AUTH_SECRET: 'short' })).toThrow()
  })
  it('uses an exact loopback origin and separate bootstrap secret', () => {
    expect(readBrowserAuthConfig({ BETTER_AUTH_SECRET: secret })?.origin).toBe('http://127.0.0.1:5173')
    expect(() => readBrowserAuthConfig({ BETTER_AUTH_SECRET: secret, OWNER_SETUP_SECRET: secret })).toThrow()
    for (const origin of ['https://example.com', 'http://localhost:5173/path', 'http://localhost:5173?x=1', 'http://user@localhost:5173']) {
      expect(() => readBrowserAuthConfig({ BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: origin })).toThrow()
    }
  })
  it('does not exempt the whole auth prefix from authorization', () => {
    const request = (method: string, url: string) => ({ method, url }) as FastifyRequest
    expect(isPublicBrowserAuthRequest(request('GET', '/api/auth/setup'))).toBe(true)
    expect(isPublicBrowserAuthRequest(request('POST', '/api/auth/sign-in/email'))).toBe(true)
    for (const path of ['/api/auth/session', '/api/auth/get-session', '/api/auth/delete-user', '/api/auth/sign-in/email/extra']) {
      expect(isPublicBrowserAuthRequest(request('GET', path))).toBe(false)
      expect(isPublicBrowserAuthRequest(request('POST', path))).toBe(false)
    }
  })
})
