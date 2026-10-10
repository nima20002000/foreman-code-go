import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const action = process.argv[2]
if (!['up', 'down', 'stop'].includes(action)) throw new Error('Usage: test-db.mjs up|down|stop')
function reusePrivateDatabase() {
  if (action !== 'up') throw new Error('The verification runtime owns private PostgreSQL shutdown')
  if (process.env.FOREMAN_CODE_CI_TEST_DATABASE !== 'running') {
    throw new Error('The verification runtime must start its private PostgreSQL before database startup')
  }
  const result = spawnSync('/usr/lib/postgresql/17/bin/psql', [
    '-h', '127.0.0.1', '-p', '55439', '-U', 'graphql_test_admin', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-Atqc',
    "select current_setting('data_directory'), shobj_description(oid, 'pg_database')"
      + " from pg_database where datname in ('postgres', 'graphql_test_control') order by datname",
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8', PGPASSWORD: 'graphql_test_disposable_only' } })
  if (result.error) throw result.error
  const expected = '/job-scratch/postgres/data|graphql-disposable-test-server'
  if (result.status !== 0 || result.stdout.trim() !== `${expected}\n${expected}`) {
    throw new Error('Private PostgreSQL test server ownership verification failed')
  }
  process.stdout.write('Reusing the runtime-owned private PostgreSQL test server\n')
}

function composeDatabase() {
  const project = 'graphql-tests'
  const file = fileURLToPath(new URL('../compose.test.yaml', import.meta.url))
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith('COMPOSE_')) delete environment[key]
  function docker(args) {
    const result = spawnSync('docker', args, { encoding: 'utf8', env: environment })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || `docker ${args[0]} failed`)
    return result.stdout.trim()
  }
  const containers = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).split('\n').filter(Boolean)
  let running = false
  for (const container of containers) {
    const [record] = JSON.parse(docker(['inspect', container]))
    if (record.Config.Labels['graphql.test-owner'] !== 'disposable-tests') {
      throw new Error('Refusing to modify a container without the disposable test ownership label')
    }
    if (record.Config.Labels['com.docker.compose.service'] === 'postgres' && record.State.Running) running = true
  }
  const volume = `${project}_graphql-test-data`
  if (docker(['volume', 'ls', '-q']).split('\n').includes(volume)) {
    const [record] = JSON.parse(docker(['volume', 'inspect', volume]))
    if (record.Labels?.['graphql.test-owner'] !== 'disposable-tests') {
      throw new Error('Refusing to modify a volume without the disposable test ownership label')
    }
  }
  const args = ['compose', '--project-name', project, '--file', file]
  // Snapshot checkouts have different bind-mount paths; replacing this shared server interrupts active tests.
  if (action === 'up') args.push('up', '-d', '--wait', running ? '--no-recreate' : '--force-recreate', 'postgres')
  else if (action === 'stop') args.push('stop', 'postgres')
  else args.push('down', '--volumes')
  process.stdout.write(`${docker(args)}\n`)
}

if (process.env.FOREMAN_CODE_VERIFICATION_ENVIRONMENT === 'isolated-job-v1') reusePrivateDatabase()
else composeDatabase()
