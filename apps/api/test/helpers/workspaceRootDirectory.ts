import { mkdtemp } from 'node:fs/promises'

/** Linux root fixtures need protected ancestors; scheduler TMPDIR can be group-writable.
 * A worker-owned 0700 entry under sticky /tmp satisfies the real filesystem guard. */
export function workspaceRootDirectory(): Promise<string> {
  return mkdtemp('/tmp/w08-workspace-root-')
}
