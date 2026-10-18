import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { environmentRequest, executionScope, goPackages, nativeSelectorBinding, repositoryRoot, suiteKind,
  validateAffectedSuite } from './ci-affected-scope.mjs'

/** Cloud images prepare native tools only for the selected work or an explicit full release. */
export function cloudNativePrerequisites(environment = process.env, root = repositoryRoot) {
  const suite = environment.SUITE
  if (suite === 'install') return false
  suiteKind(suite)
  if (executionScope(environment, root) === 'full') {
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
  // Unselected manifest entries and arbitrary native report claims do not request native tools.
  return goPackages(request).length > 0 || request.conformanceScenarios.length > 0
    || selectors.length > 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${cloudNativePrerequisites()}\n`)
}
