import { execFileSync } from 'node:child_process'

/**
 * Decides whether a pull request's findings are approved by a maintainer label.
 * A push that adds findings revokes the approval; `findingsSincePreviousPush` is undefined
 * when the previous head is unknown, which also revokes it.
 */
export function reviewWithApproval({ findings, findingsSincePreviousPush, approved, isNewPush }) {
  if (findings.length === 0) return { pass: true, revokeApproval: false }
  const changedAgain = isNewPush && (findingsSincePreviousPush === undefined || findingsSincePreviousPush.length > 0)
  const revokeApproval = approved && changedAgain
  return { pass: approved && !changedAgain, revokeApproval }
}

/** Pull request context that the review workflows pass in the environment. */
export function pullRequestEvent(environment = process.env) {
  return {
    baseSha: environment.BASE_SHA,
    headSha: environment.HEAD_SHA,
    beforeSha: environment.BEFORE_SHA,
    isNewPush: environment.EVENT_ACTION === 'synchronize',
    labels: JSON.parse(environment.LABELS ?? '[]'),
  }
}

export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

export async function removeLabel(label, environment = process.env) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = environment
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels/${label}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
  })
  if (!response.ok && response.status !== 404) throw new Error(`Removing the "${label}" label failed: ${response.status}`)
}

export async function enforceApproval({ label, findings, findingsSincePreviousPush, event, describe }) {
  const approved = event.labels.includes(label)
  const result = reviewWithApproval({ findings, findingsSincePreviousPush, approved, isNewPush: event.isNewPush })
  if (result.revokeApproval) await removeLabel(label)
  if (result.pass) return
  const reason = result.revokeApproval ? `New commits added to this list after approval, so "${label}" was removed.\n` : ''
  process.stderr.write(`${reason}${describe}\nA maintainer must review this list and add the "${label}" label:\n`
    + `${findings.map((item) => `  ${item}`).join('\n')}\n`)
  process.exit(1)
}
