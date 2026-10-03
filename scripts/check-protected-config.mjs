import { execFileSync } from 'node:child_process'
import { APPROVAL_LABEL, reviewProtectedChanges } from './protected-config.mjs'

const { BASE_SHA, HEAD_SHA, BEFORE_SHA, EVENT_ACTION, LABELS, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = process.env

function changedFiles(range) {
  return execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' }).split('\n').filter(Boolean)
}

function changedSincePreviousPush() {
  try {
    return changedFiles(`${BEFORE_SHA}..${HEAD_SHA}`)
  } catch {
    // A force push can make the previous head unreachable; treat everything as changed.
    return undefined
  }
}

async function removeApprovalLabel() {
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels/${APPROVAL_LABEL}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
  })
  if (!response.ok && response.status !== 404) throw new Error(`Removing the approval label failed: ${response.status}`)
}

const isNewPush = EVENT_ACTION === 'synchronize'
const result = reviewProtectedChanges({
  changedInPullRequest: changedFiles(`${BASE_SHA}...${HEAD_SHA}`),
  changedSincePreviousPush: isNewPush ? changedSincePreviousPush() : [],
  labels: JSON.parse(LABELS ?? '[]'),
  isNewPush,
})

if (result.revokeApproval) await removeApprovalLabel()
if (!result.pass) {
  const reason = result.revokeApproval
    ? 'New commits changed protected files after approval, so the approval was removed.'
    : 'This pull request changes files that decide whether checks pass.'
  process.stderr.write(`${reason}\nA maintainer must review these changes and add the "${APPROVAL_LABEL}" label:\n`
    + `${result.changed.map((path) => `  ${path}`).join('\n')}\n`)
  process.exit(1)
}
