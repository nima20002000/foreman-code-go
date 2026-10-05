import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const environment = { NODE_ENV: 'production', GRAPHQL_LOCAL_PRODUCTION: '1', HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://owner:password@127.0.0.1:55440/graphql_production' }

it('validates supported production operator overrides and retains their effective values', () => {
  expect(loadConfig({ ...environment, CODEX_BINARY: '/opt/codex', OPENCODE_BINARY: '/opt/opencode',
    HARNESS_TIMEOUT_MS: '600000', DATABASE_QUERY_TIMEOUT_MS: '2000', GRAPHQL_OPENCODE_PARITY_QUALIFIED: '1' }))
    .toMatchObject({ harnesses: { codexBinary: '/opt/codex', openCodeBinary: '/opt/opencode', timeoutMs: 600000 },
      database: { queryTimeoutMs: 2000 } })
  for (const invalid of [{ HARNESS_TIMEOUT_MS: '-1' }, { GRAPHQL_OPENCODE_PARITY_QUALIFIED: 'invalid' },
    { HOST: '0.0.0.0' }, { DATABASE_URL: 'postgresql://owner:password@remote/graphql_production' }]) {
    expect(() => loadConfig({ ...environment, ...invalid })).toThrow()
  }
})
