import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { environmentRequest, executionScope, goPackages, nativeSelectorBinding, repositoryRoot, selectedNativeRequests, suiteKind,
  validateAffectedSuite } from './ci-affected-scope.mjs'

/** Cloud images prepare native tools only for the selected work or an explicit full release. */
export function cloudNativePrerequisites(environment = process.env, root = repositoryRoot, prerequisite = 'native') {
  if (!['native', 'openssl'].includes(prerequisite)) throw new Error(`Unsupported cloud native prerequisite: ${prerequisite}`)
  const suite = environment.SUITE
  if (suite === 'install') return false
  suiteKind(suite)
  if (executionScope(environment, root) === 'full') {
    if (prerequisite === 'openssl') return false
    return ['typecheck', 'typecheck-api', 'lint', 'lint-api', 'unit', 'unit-api', 'build', 'build-api',
      'integration'].includes(suite)
  }
  const request = validateAffectedSuite(suite, environmentRequest(environment, root), root)
  const selectors = Object.keys(request.nativeReports)
  for (const selector of selectors) {
    if (!nativeSelectorBinding(selector, root)) {
      throw new Error(`Cloud native prerequisites require a committed selected adapter binding: ${selector}`)
    }
  }
  // Unselected manifest entries and source checks never request a wrapper's inner native tools.
  const requests = selectedNativeRequests(suite, request, root)
  if (prerequisite === 'openssl') return requests.some(value => value.nativePrerequisites.includes('openssl'))
  return requests.some(value => goPackages(value).length > 0 || value.conformanceScenarios.length > 0)
    || selectors.length > 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 1 || args[0] !== '--openssl')) throw new Error('Pass only --openssl to select the pinned OpenSSL prerequisite.')
  process.stdout.write(`${cloudNativePrerequisites(process.env, repositoryRoot, args.length ? 'openssl' : 'native')}\n`)
}
