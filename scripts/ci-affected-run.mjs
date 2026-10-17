// Older host dispatches can still enter this script with explicit nonempty TS selections.
// Route those requests through the same complete fork suite instead of running frozen API tests.
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryFileList, selectByIndexes } from './ci-files.mjs'

export function affectedCommands(suite) {
  if (!['typecheck', 'lint', 'unit', 'integration', 'build'].includes(suite)) {
    throw new Error(`Unsupported affected suite: ${suite}`)
  }
  return [['env', `SUITE=${suite}`, 'SCOPE=full', 'bash', 'scripts/ci-suite.sh']]
}

/** Validate the supplied selection even though it cannot narrow the migration suite. */
export function readAffectedSelection(option, value, cwd = process.cwd()) {
  let files
  if (option === '--files-from') {
    if (typeof value !== 'string' || !value) throw new Error('Pass a selection file after --files-from.')
    files = JSON.parse(readFileSync(resolve(cwd, value), 'utf8'))
  } else if (option === '--indexes') {
    if (value !== undefined && typeof value !== 'string') throw new Error('CI file indexes must be a string.')
    files = selectByIndexes(repositoryFileList(cwd), value ?? '')
  } else throw new Error('Pass --files-from or --indexes for CI; the fork always runs full scope.')
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) {
    throw new Error('CI selection must contain existing repository files.')
  }
  for (const file of files) {
    if (!file || file.includes('\0') || file.includes('\\') || posix.isAbsolute(file) || win32.isAbsolute(file)
      || posix.normalize(file) !== file || file.split('/').includes('..')) {
      throw new Error(`Invalid CI file: ${file}`)
    }
  }
  const missing = files.filter(file => !lstatSync(resolve(cwd, file), { throwIfNoEntry: false })?.isFile())
  if (missing.length) throw new Error(`CI selection must contain existing repository files: ${missing.join(', ')}`)
  return files
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
  const [suite, option, value, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error('Unexpected arguments after the CI file selection.')
  const command = affectedCommands(suite)[0]
  readAffectedSelection(option, value)
  console.log('Ignoring the frozen TypeScript selection and running the complete fork suite.')
  process.exitCode = await run(command)
}
