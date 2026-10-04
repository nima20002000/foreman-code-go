import { describe, expect, it } from 'vitest'
import { resolveLocalBrowserOrigin } from '@foreman-code/contracts/browser-origin'
import { loadConfig } from '../src/config.js'

const base = { DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1/graphql' }
describe('effective local browser origin', () => {
  it('derives the frontend port and preserves exact host identity', () => {
    expect(resolveLocalBrowserOrigin({})).toEqual({ origin: 'http://127.0.0.1:5173', host: '127.0.0.1', port: 5173 })
    expect(resolveLocalBrowserOrigin({ GRAPHQL_WEB_PORT: '5198' }).origin).toBe('http://127.0.0.1:5198')
    expect(resolveLocalBrowserOrigin({ GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5198' })).toEqual({
      origin: 'http://localhost:5198', host: 'localhost', port: 5198,
    })
    expect(loadConfig({ ...base, GRAPHQL_WEB_PORT: '5198' }).browserOrigin).toBe('http://127.0.0.1:5198')
  })
  it('rejects conflicting or nonloopback origins', () => {
    for (const environment of [
      { GRAPHQL_BROWSER_ORIGIN: 'http://example.com:5198' },
      { GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5198/path' },
      { GRAPHQL_BROWSER_ORIGIN: 'http://localhost:5198', GRAPHQL_WEB_PORT: '5199' },
      { GRAPHQL_WEB_PORT: '0' },
    ]) expect(() => loadConfig({ ...base, ...environment })).toThrow()
  })
})
