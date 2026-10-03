import { execFileSync } from 'node:child_process'

// ESLint applies eslint-suppressions.json automatically, which would silence violations instead of fixing them.
const patterns = ['eslint-suppressions.json', '**/eslint-suppressions.json']
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...patterns], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

if (files.length > 0) {
  process.stderr.write(`Lint suppression files are not allowed; fix the violations instead:\n${files.join('\n')}\n`)
  process.exit(1)
}
