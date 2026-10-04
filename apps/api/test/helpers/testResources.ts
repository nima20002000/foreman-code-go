export { createFixtureDatabase, dropFixtureDatabase, createFixtureSchema, dropFixtureSchema,
  ownedTestDatabaseUrl, ownedTestPath, removeFixtureDirectory } from '../../../../scripts/test-resources.mjs'

import type pg from 'pg'
import { RuntimeIdentitySchema } from '@graphql/contracts'
import { createRuntimeIdentity } from '@graphql/contracts/runtime-identity-node'
import { assertTestDatabase, ownedTestDatabaseUrl } from '../../../../scripts/test-resources.mjs'

/** Prepared native acceptance must bind its HTTP endpoint to the owned test database. */
export async function assertOwnedTestApi(origin: URL, pool: pg.Pool): Promise<void> {
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Native acceptance requires a loopback test API')
  }
  const databaseUrl = ownedTestDatabaseUrl()
  await assertTestDatabase(pool, { directory: process.env.GRAPHQL_TEST_ROOT!, token: process.env.GRAPHQL_TEST_OWNER!,
    name: new URL(databaseUrl).pathname.slice(1), databaseUrl })
  const result = await pool.query<{ id: string }>('select id from application_installation where singleton=true')
  const expected = createRuntimeIdentity(process.env.GRAPHQL_TEST_ROOT!, databaseUrl, result.rows[0]?.id ?? '')
  const response = await fetch(new URL('/health/identity', origin), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Test API identity is unavailable')
  const identity = RuntimeIdentitySchema.parse(await response.json())
  if (identity.databaseId !== expected.databaseId || identity.installationId !== expected.installationId) {
    throw new Error('Native acceptance API does not own the disposable test database')
  }
}
