import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { repositoryFileList, selectByIndexes } from './ci-files.mjs'

const projects = ['packages/contracts', 'apps/api', 'apps/web', 'apps/worker']

/** Commands use argument arrays; supplied file names never become shell code. */
export function affectedCommands(suite, files) {
  const groups = new Map()
  for (const file of files) {
    if (posix.normalize(file) !== file || file.startsWith('/') || file.split('/').includes('..')
      || (!projects.some(project => file.startsWith(`${project}/`)) && !file.startsWith('scripts/'))) {
      throw new Error(`Invalid CI file: ${file}`)
    }
    const project = projects.find(value => file.startsWith(`${value}/`))
    const key = project ?? 'scripts'
    groups.set(key, [...groups.get(key) ?? [], file])
  }
  const commands = []
  for (const [project, selected] of groups) {
    if (suite === 'typecheck') {
      if (project !== 'scripts' && project !== 'apps/worker') commands.push(['corepack', 'pnpm', '--dir', project, 'typecheck'])
    } else if (suite === 'lint') {
      if (project === 'scripts') throw new Error('Scripts have no package lint command.')
      commands.push(['corepack', 'pnpm', '--dir', project, 'exec', 'eslint',
        ...selected.map(file => file.slice(project.length + 1)), '--max-warnings', '0'])
    } else if (suite === 'unit') {
      if (selected.some(file => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        || (file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file)))) {
        throw new Error('Unit scope requires unit test files.')
      }
      const nodeFiles = selected.filter(file => file.endsWith('.mjs'))
      const vitestFiles = selected.filter(file => !file.endsWith('.mjs'))
      if (nodeFiles.length) commands.push([process.execPath, '--test', ...nodeFiles])
      if (vitestFiles.length) commands.push(['corepack', 'pnpm', '--dir', project, 'exec', 'vitest', 'run',
        ...vitestFiles.map(file => file.slice(project.length + 1))])
    } else throw new Error(`Unsupported affected suite: ${suite}`)
  }
  return commands
}

async function run(command) {
  const environment = { ...process.env, CI: 'true' }
  // Nested CI commands in tests must not inherit this run's dispatch selection.
  delete environment.SCOPE
  delete environment.SELECTED_FILES
  delete environment.SLICE
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: environment })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [suite, option, value] = process.argv.slice(2)
  let files
  if (option === '--files-from') files = JSON.parse(readFileSync(value, 'utf8'))
  else if (option === '--indexes') files = selectByIndexes(repositoryFileList(process.cwd()), value ?? '')
  else throw new Error('Pass --files-from or --indexes for affected CI.')
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !lstatSync(file).isFile())) {
    throw new Error('CI selection must contain existing repository files.')
  }
  const commands = affectedCommands(suite, files)
  if (commands.length) {
    const code = await run(['corepack', 'pnpm', '--filter', '@foreman-code/contracts', 'build'])
    if (code) process.exit(code)
  }
  for (const command of commands) {
    const wrapped = suite === 'unit' ? [process.execPath, 'scripts/test-command.mjs', '--', ...command] : command
    const code = await run(wrapped)
    if (code) { process.exitCode = code; break }
  }
  if (!commands.length) console.log('No affected files for this suite.')
}
