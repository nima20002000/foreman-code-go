import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import type pg from 'pg'
import { resolveLocalBrowserOrigin } from '@foreman-code/contracts/browser-origin'
import { loadConfig } from '../src/config.js'
import { LocalDevBrowserAccess } from '../src/modules/access/localDevBrowser.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'

const base = { DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1/graphql', GRAPHQL_DEV_BROWSER_ACCESS: '1' }
describe('effective local browser origin', () => {
  it('derives the frontend port and preserves exact host identity', () => {
    expect(resolveLocalBrowserOrigin({})).toEqual({ origin: 'http://127.0.0.1:5173', host: '127.0.0.1', port: 5173 })
    expect(resolveLocalBrowserOrigin({ GRAPHQL_WEB_PORT: '5198' }).origin).toBe('http://127.0.0.1:5198')
    expect(resolveLocalBrowserOrigin({ GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5198' })).toEqual({
      origin: 'http://localhost:5198', host: 'localhost', port: 5198,
    })
    expect(resolveLocalBrowserOrigin({ GRAPHQL_DEV_BROWSER_ORIGIN: 'http://localhost:5198' }).origin).toBe('http://localhost:5198')
    expect(() => resolveLocalBrowserOrigin({ GRAPHQL_DEV_BROWSER_ORIGIN: 'http://localhost:5198', GRAPHQL_BROWSER_ORIGIN: 'http://127.0.0.1:5198' })).toThrow()
    const config = loadConfig({ ...base, GRAPHQL_WEB_PORT: '5198', BETTER_AUTH_SECRET: 'x'.repeat(48) })
    expect(config.localDevBrowserAccess?.origin).toBe('http://127.0.0.1:5198')
    expect(config.browserAuth?.origin).toBe(config.localDevBrowserAccess?.origin)
    expect(loadConfig({ DATABASE_URL: base.DATABASE_URL, BETTER_AUTH_SECRET: 'x'.repeat(48),
      BETTER_AUTH_URL: 'https://localhost:5443' }).browserAuth?.origin).toBe('https://localhost:5443')
  })
  it('rejects conflicting or nonloopback origins', () => {
    for (const environment of [
      { GRAPHQL_BROWSER_ORIGIN: 'http://example.com:5198' },
      { GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5198/path' },
      { GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5198', GRAPHQL_WEB_PORT: '5199' },
      { GRAPHQL_WEB_PORT: '0' },
      { GRAPHQL_WEB_PORT: '5198', BETTER_AUTH_SECRET: 'x'.repeat(48), BETTER_AUTH_URL: 'http://localhost:5198' },
    ]) expect(() => loadConfig({ ...base, ...environment })).toThrow()
  })
  it('enforces the selected exact origin, mutation origin and loopback client', () => {
    const access = new LocalDevBrowserAccess({} as pg.Pool, {} as PostgresAccessService, 'http://localhost:5198')
    const request = (origin?: string, ip = '127.0.0.1', site?: string) => ({ ip, headers: {
      ...(origin ? { origin } : {}), ...(site ? { 'sec-fetch-site': site } : {}),
    } }) as FastifyRequest
    expect(() => access.requireLocalBrowser(request('http://localhost:5198'), true)).not.toThrow()
    expect(() => access.requireLocalBrowser(request(), false)).not.toThrow()
    for (const invalid of [request('http://127.0.0.1:5198'), request('http://localhost:5173'), request(),
      request('http://localhost:5198', '192.0.2.1'), request('http://localhost:5198', '127.0.0.1', 'cross-site')]) {
      expect(() => access.requireLocalBrowser(invalid, true)).toThrow()
    }
  })
})
