// Shrinks scripts/lint-allowlist.json to the files, test names and import cycles that still break a rule.
//   node scripts/lint-baseline.mjs
// Runs each package's ESLint with the allowlist disabled. It never adds an entry: the allowlist only shrinks.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiImportGraph, importCycles, newCycles } from './check-import-cycles.mjs'
import { hasTicketName } from './check-test-names.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const file = `${root}/scripts/lint-allowlist.json`
const allowlist = JSON.parse(readFileSync(file, 'utf8'))

const failing = new Map(Object.keys(allowlist.eslint).map(id => [id, new Set()]))
for (const project of ['apps/api', 'apps/web', 'apps/worker', 'packages/contracts']) {
  const result = spawnSync('corepack', ['pnpm', '--dir', project, 'exec', 'eslint', '.', '--format', 'json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, FOREMAN_LINT_BASELINE: '1' },
  })
  if (result.status !== 0 && result.status !== 1) throw new Error(`ESLint failed in ${project}:\n${result.stderr}`)
  for (const report of JSON.parse(result.stdout)) {
    for (const message of report.messages) failing.get(message.ruleId)?.add(relative(root, report.filePath))
  }
}

const before = JSON.stringify(allowlist)
for (const [id, files] of Object.entries(allowlist.eslint)) allowlist.eslint[id] = files.filter(path => failing.get(id).has(path))
allowlist['test-names'] = allowlist['test-names'].filter(path => existsSync(`${root}/${path}`) && hasTicketName(path))
allowlist['import-cycles'] = importCycles(apiImportGraph()).filter(cycle => !newCycles([cycle], allowlist['import-cycles']).length)
writeFileSync(file, `${JSON.stringify(allowlist, null, 2)}\n`)
console.log(before === JSON.stringify(allowlist) ? 'The allowlist is already minimal.' : 'Pruned scripts/lint-allowlist.json.')
