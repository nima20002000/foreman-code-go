import { enforceApproval, git, pullRequestEvent } from './label-approval.mjs'
import { removedTests, testDefinitions } from './test-inventory.mjs'
import { TEST_FILE } from './test-results.mjs'

export const APPROVAL_LABEL = 'test-removal-approved'

function inventory(commit) {
  const files = git('ls-tree', '-r', '--name-only', commit).split('\n').filter((path) => TEST_FILE.test(path))
  return new Map(files.map((file) => [file, testDefinitions(file, git('show', `${commit}:${file}`))]))
}

function removedSincePreviousPush(event, head) {
  try {
    return removedTests(inventory(event.beforeSha), head)
  } catch {
    // A force push can make the previous head unreachable.
    return undefined
  }
}

const event = pullRequestEvent()
const head = inventory(event.headSha)
const base = inventory(git('merge-base', event.baseSha, event.headSha).trim())
await enforceApproval({
  label: APPROVAL_LABEL,
  findings: removedTests(base, head),
  findingsSincePreviousPush: event.isNewPush ? removedSincePreviousPush(event, head) : [],
  event,
  describe: 'This pull request removes or renames tests. Renamed tests appear under their old titles.',
})
