// Files that decide what counts as passing: lint, test, type and CI configuration, dependency policy and agent rules.
const PROTECTED = [
  /^packages\/eslint-config\//,
  /(?:^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(?:^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)package\.json$/,
  /^\.npmrc$/,
  /^pnpm-workspace\.yaml$/,
  /^\.github\//,
  /^scripts\/(?:protected-config|label-approval|check-[^/]+|heavy-job|test-integration|vitest-heavy-setup)\.mjs$/,
  /^scripts\/(?:test-results|test-inventory|node-test-results-reporter|run-mutation-tests|mutation-[a-z]+|stryker\.config)\.mjs$/,
  /^test-policy\.json$/,
  /^AGENTS\.md$/,
]

export const APPROVAL_LABEL = 'protected-config-approved'

export function protectedFiles(paths) {
  return paths.filter((path) => PROTECTED.some((pattern) => pattern.test(path)))
}
