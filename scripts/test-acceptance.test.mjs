import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { adminDatabaseUrl } from './test-integration.mjs'
import { withAcceptanceDatabase } from './test-acceptance.mjs'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

async function exists(database) {
  const pool = new Pool({ connectionString: adminDatabaseUrl(), max: 1 })
  try { return (await pool.query('select 1 from pg_database where datname=$1', [database])).rowCount === 1 }
  finally { await pool.end() }
}

test('native acceptance owns a fresh database per invocation and removes it after success', async () => {
  const names = []
  for (let invocation = 0; invocation < 2; invocation++) {
    await withAcceptanceDatabase(async url => {
      const pool = new Pool({ connectionString: url, max: 1 })
      try {
        const database = (await pool.query('select current_database() as name')).rows[0].name
        names.push(database)
        assert.match(database, /^graphql_native_test_[a-f0-9]{32}$/)
        await pool.query('create table acceptance_owned (id integer)')
        assert.equal(await exists(database), true)
      } finally { await pool.end() }
    })
    assert.equal(await exists(names.at(-1)), false)
  }
  assert.notEqual(names[0], names[1])
})

test('native acceptance removes only its own database after a failed test run', async () => {
  let database
  const failure = new Error('Native scenario failed.')
  await assert.rejects(withAcceptanceDatabase(async url => {
    database = new URL(url).pathname.slice(1)
    assert.equal(await exists(database), true)
    throw failure
  }), error => error === failure)
  assert.equal(await exists(database), false)
  assert.equal(await exists('postgres'), true)
})
