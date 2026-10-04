import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { posix } from 'node:path'

const [mode, ...files] = process.argv.slice(2)
const modes = ['scripts', 'unit', 'integration', 'acceptance']
if (!modes.includes(mode) || !files.length) {
  throw new Error('Usage: test-files.mjs scripts|unit|integration|acceptance <test files...>')
}
const suffixes = { scripts: '.test.mjs', unit: '.test.ts',
  integration: '.integration.test.ts', acceptance: '.acceptance.test.ts' }
for (const file of files) {
  const prefix = mode === 'scripts' ? 'scripts/' : 'apps/api/'
  if (!file.startsWith(prefix) || !file.endsWith(suffixes[mode]) || posix.normalize(file) !== file
    || file.split('/').some(part => part === '..') || !lstatSync(file).isFile()) {
    throw new Error(`Invalid ${mode} test file: ${file}`)
  }
  if (mode === 'unit' && /\.(integration|acceptance)\.test\.ts$/.test(file)) {
    throw new Error('Integration and acceptance files require their own test mode')
  }
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (value, signal) => resolve(value ?? (signal === 'SIGINT' ? 130 : 143)))
  })
  if (code !== 0) {
    process.exitCode = code
    throw new Error(`Selected ${mode} tests failed with exit ${code}`)
  }
}

await run('corepack', ['pnpm', '--filter', '@graphql/contracts', 'build'])
if (mode === 'scripts') {
  await run(process.execPath, ['--test', ...files])
} else if (mode === 'integration') {
  await run(process.execPath, ['scripts/test-integration.mjs', '--files', ...files])
} else {
  await run('corepack', ['pnpm', '--filter', '@graphql/api', 'exec', 'vitest', 'run',
    ...files.map(file => file.slice('apps/api/'.length)), '--no-file-parallelism', '--maxWorkers=1'])
}
