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
  /^scripts\/(?:protected-config|check-[^/]+|heavy-job|test-integration|vitest-heavy-setup)\.mjs$/,
  /^AGENTS\.md$/,
]

export const APPROVAL_LABEL = 'protected-config-approved'

export function protectedFiles(paths) {
  return paths.filter((path) => PROTECTED.some((pattern) => pattern.test(path)))
}

/**
 * Decides whether a pull request may change protected files.
 * `changedSincePreviousPush` is undefined when the previous head is unknown, which revokes approval.
 */
export function reviewProtectedChanges({ changedInPullRequest, changedSincePreviousPush, labels, isNewPush }) {
  const changed = protectedFiles(changedInPullRequest)
  if (changed.length === 0) return { pass: true, changed, revokeApproval: false }
  const approved = labels.includes(APPROVAL_LABEL)
  const changedAgain = isNewPush && (changedSincePreviousPush === undefined
    || protectedFiles(changedSincePreviousPush).length > 0)
  const revokeApproval = approved && changedAgain
  return { pass: approved && !changedAgain, changed, revokeApproval }
}
