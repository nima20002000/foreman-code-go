import { SourceError } from './manifest.js'

export function gitFailure(code: 'SOURCE_WORKTREE_FAILED' | 'SOURCE_SNAPSHOT_FAILED', operation: string | undefined) {
  // Credential helpers can write arbitrary secrets to stderr; disclose only the operation.
  return new SourceError(code,
    `git ${operation ?? 'operation'} failed. Check repository access and local Git configuration, then retry.`)
}
