import { APPROVAL_LABEL, protectedFiles } from './protected-config.mjs'
import { enforceApproval, git, pullRequestEvent } from './label-approval.mjs'

const event = pullRequestEvent()
const changedFiles = (range) => git('diff', '--name-only', range).split('\n').filter(Boolean)

function changedSincePreviousPush() {
  try {
    return protectedFiles(changedFiles(`${event.beforeSha}..${event.headSha}`))
  } catch {
    // A force push can make the previous head unreachable.
    return undefined
  }
}

await enforceApproval({
  label: APPROVAL_LABEL,
  findings: protectedFiles(changedFiles(`${event.baseSha}...${event.headSha}`)),
  findingsSincePreviousPush: event.isNewPush ? changedSincePreviousPush() : [],
  event,
  describe: 'This pull request changes files that decide whether checks pass.',
})
