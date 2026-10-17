// Older host dispatches can still enter this script with explicit nonempty TS selections.
// Route those requests through the same complete fork suite instead of running frozen API tests.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function affectedCommands(suite) {
  if (!['typecheck', 'lint', 'unit', 'integration', 'build'].includes(suite)) {
    throw new Error(`Unsupported affected suite: ${suite}`)
  }
  return [['env', `SUITE=${suite}`, 'SCOPE=full', 'bash', 'scripts/ci-suite.sh']]
}

async function run(command) {
  const environment = { ...process.env, CI: 'true' }
  for (const name of ['SELECTED_FILES', 'SLICE', 'CI_PARTITION', 'CI_SELECTION_COMMIT']) delete environment[name]
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: environment })
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolveExit(code ?? 1))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [suite, option] = process.argv.slice(2)
  if (option !== '--files-from' && option !== '--indexes') {
    throw new Error('Pass --files-from or --indexes for CI; the fork always runs full scope.')
  }
  console.log('Ignoring the frozen TypeScript selection and running the complete fork suite.')
  process.exitCode = await run(affectedCommands(suite)[0])
}
