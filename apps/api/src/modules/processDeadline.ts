/** Runs `file` under a detached `timeout` supervisor. The supervisor outlives the API with the deadline (and any lock
 * descriptors the command inherits); at expiry it signals the command's whole process group, then kills it. */
export function underDeadline(timeoutMs: number, file: string, args: readonly string[]): [string, string[]] {
  return ['timeout', ['--signal=TERM', '--kill-after=0.25s', `${timeoutMs / 1000}s`, file, ...args]]
}
