import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const projects = ['apps/api', 'apps/web', 'packages/contracts']
const files = process.argv.slice(2).filter((argument, index) => index !== 0 || argument !== '--')
if (!files.length) throw new Error('Pass the repository-relative test files to run.')

const selections = new Map()
for (const file of files) {
  const project = projects.find((folder) => file.startsWith(`${folder}/`))
  if (!project || posix.normalize(file) !== file || file.includes('..')
    || !/\.test\.(?:ts|tsx|mjs)$/.test(file) || !existsSync(resolve(root, file))) {
    throw new Error(`Invalid test file: ${file}`)
  }
  const selected = selections.get(project) ?? new Set()
  selected.add(file.slice(project.length + 1))
  selections.set(project, selected)
}

for (const [project, selected] of selections) {
  const result = spawnSync('corepack', ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=12', ...selected], {
    cwd: resolve(root, project), stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = 1
}
