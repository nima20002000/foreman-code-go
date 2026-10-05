import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const action = process.argv[2]
if (!['up', 'down', 'stop'].includes(action)) throw new Error('Usage: test-db.mjs up|down|stop')
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
