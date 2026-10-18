// Host CI calls root package scripts for unpartitioned suites and integration.
// Preserve their ordinary command outside CI; inside CI use the tested tree's suite mapping.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { explicitRelease, readAffectedRequest, repositoryRoot, validateAffectedSuite } from './ci-affected-scope.mjs'

const [suite, separator, ...fallback] = process.argv.slice(2)
if (!['typecheck', 'lint', 'unit', 'build', 'integration'].includes(suite) || separator !== '--' || !fallback.length) {
  throw new Error('Usage: ci-root-suite.mjs <suite> -- <ordinary command> [args...]')
}
const inCi = process.env.CI_HOST_RUNNER === '1' || ['true', '1'].includes(process.env.CI)
  || process.env.FOREMAN_CODE_CI_HOST === '1' || process.env.FOREMAN_CODE_CI_LOCAL === '1'
let directory
try {
  const environment = inCi ? { ...process.env, SUITE: suite } : process.env
  const command = inCi ? ['bash', fileURLToPath(new URL('./ci-suite.sh', import.meta.url))] : fallback
  if (inCi && !explicitRelease(environment) && suite === 'integration' && fallback.includes('--files')) {
    const index = fallback.indexOf('--files')
    const files = fallback.slice(index + 1)
    const request = validateAffectedSuite(suite, readAffectedRequest(files))
    directory = mkdtempSync(join(tmpdir(), 'ci-root-selection-'))
    const selection = join(directory, 'selected.json')
    writeFileSync(selection, JSON.stringify(request), { mode: 0o600, flag: 'wx' })
    environment.SCOPE = 'affected'
    environment.CI_AFFECTED_SELECTION_FILE = selection
  }
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit',
    cwd: inCi ? repositoryRoot : process.cwd(), env: environment })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true })
}
