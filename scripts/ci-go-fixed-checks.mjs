import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function fixedChecks({ plan, env, checkout, root, go, stockCache, facts, required, run }) {
  env.SUITE = 'lint'
  try {
    await required('stock-pinned-Staticcheck-install', 'bash', ['scripts/ci-go-toolchain.sh', 'install'])
  } finally {
    env.SUITE = 'unit'
  }
  const pins = JSON.parse(await readFile(join(checkout, 'scripts/ci-go-versions.json'), 'utf8'))
  const staticcheck = join(stockCache, 'tools', 'staticcheck-' + pins.staticcheck.version, 'bin/staticcheck')
  env.PATH = dirname(go) + ':' + dirname(staticcheck) + ':' + env.PATH
  const version = await required('actual-Staticcheck-version', staticcheck, ['-version'])
  if (!version.stdout.trim().endsWith('(' + pins.staticcheck.version.slice(1) + ')')) {
    throw new Error('Staticcheck does not match the stock pin')
  }
  facts.staticcheckVersion = version.stdout.trim()
  const checks = []
  const backend = join(checkout, 'backend')
  for (const command of ['build', 'vet']) {
    checks.push(await run('affected-package-' + command, go, [command, ...plan.analysisPackages], backend))
  }
  checks.push(await run('affected-package-Staticcheck', staticcheck, plan.analysisPackages, backend))
  facts.startupBuildExecuted = true
  checks.push(await run('affected-startup-build', go, ['build', '-o', join(root, 'foreman'), './cmd/foreman'], backend))
  const formatted = await run('seven-affected-format-paths', join(dirname(go), 'gofmt'), ['-l', ...plan.formatFiles])
  checks.push(formatted)
  facts.unformatted = formatted.stdout.split('\n').filter(Boolean)
  if (facts.unformatted.length) {
    checks.push(await run('affected-format-diff', join(dirname(go), 'gofmt'), ['-d', ...facts.unformatted]))
  }
  return checks.every(command => command.exitCode === 0) && facts.unformatted.length === 0
}
