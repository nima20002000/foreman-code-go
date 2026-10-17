// Host CI calls root package scripts for unpartitioned suites and integration.
// Preserve their ordinary command outside CI; inside CI use the tested tree's suite mapping.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [suite, separator, ...fallback] = process.argv.slice(2)
if (!['typecheck', 'lint', 'unit', 'build', 'integration'].includes(suite) || separator !== '--' || !fallback.length) {
  throw new Error('Usage: ci-root-suite.mjs <suite> -- <ordinary command> [args...]')
}
const inCi = process.env.CI_HOST_RUNNER === '1' || ['true', '1'].includes(process.env.CI)
  || process.env.FOREMAN_CODE_CI_HOST === '1' || process.env.FOREMAN_CODE_CI_LOCAL === '1'
const command = inCi ? ['bash', fileURLToPath(new URL('./ci-suite.sh', import.meta.url))] : fallback
if (inCi && suite === 'integration' && fallback.includes('--files')) {
  console.log('Go integration always runs full scope; the frozen TypeScript file selection is ignored.')
}
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit',
  env: inCi ? { ...process.env, SUITE: suite, SCOPE: 'full' } : process.env,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
