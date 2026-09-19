import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

function run(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn('corepack', ['pnpm', '--filter', '@graphql/api', 'test:integration'], { stdio: 'inherit', env: environment })
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const detach = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
    child.once('error', (error) => { detach(); reject(error) })
    child.once('exit', (code) => { detach(); resolve(code ?? 1) })
  })
}

// An explicitly supplied test database remains an operator choice. By default,
// never use the running app's database: several suites exercise global settings.
async function main() {
  if (process.env.TEST_DATABASE_URL) { process.exitCode = await run(process.env); return }
  const connection = new URL('postgresql://graphql:graphql@127.0.0.1:5432/postgres')
  const name = `graphql_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: connection.toString(), max: 1 })
  let created = false
  try {
    await admin.query(`create database "${name}"`)
    created = true
    connection.pathname = `/${name}`
    console.log('Running integration tests in a disposable database; the development database is unchanged.')
    process.exitCode = await run({ ...process.env, TEST_DATABASE_URL: connection.toString() })
  } finally {
    try { if (created) await admin.query(`drop database "${name}" with (force)`) }
    finally { await admin.end() }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
