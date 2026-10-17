import { execFileSync } from 'node:child_process'

/** The host calls this export before deciding whether a suite has any work to run. */
export function selectAffectedFiles({ suite }) {
  const reason = ['unit', 'integration', 'lint', 'typecheck', 'build'].includes(suite)
    ? 'Fork CI requires the complete Go backend and retained TypeScript checks; Go affected selection is not supported.'
    : 'This suite requires a full run.'
  return { scope: 'full', files: [], reason }
}

/** Read the snapshot tree against an explicit ancestor or its default branch merge-base. */
export function affectedSnapshot(commit, suite, cwd = process.cwd(), defaultRef = 'origin/main', baseCommit) {
  cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  const git = (args, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
  if (!baseCommit && git(['rev-list', '--parents', '-n', '1', commit]).split(' ').length > 2) {
    return { scope: 'full', files: [], reason: 'Merge commits require a full run.' }
  }
  let base
  if (baseCommit) {
    try {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new Error('Invalid base SHA.')
      git(['merge-base', '--is-ancestor', baseCommit, commit])
      base = baseCommit
    } catch {
      return { scope: 'full', files: [], reason: 'baseCommit is unavailable or is not an ancestor of the resolved commit.' }
    }
  } else {
    try {
      if (git(['rev-parse', '--verify', defaultRef]) === git(['rev-parse', commit])) {
        return { scope: 'full', files: [], reason: 'The commit is the workspace default branch head.' }
      }
      base = git(['merge-base', commit, defaultRef])
    }
    catch { return { scope: 'full', files: [], reason: 'No merge-base with the default branch is available.' } }
  }
  // Preserve base validation for dispatch diagnostics, but never narrow the migration suites.
  git(['diff', '--name-only', '--no-renames', base, commit])
  return selectAffectedFiles({ suite })
}
