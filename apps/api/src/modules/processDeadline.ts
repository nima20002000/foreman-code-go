/** Runs `file` under a detached supervisor (its caller spawns it as a process group leader). The supervisor outlives the
 * API with the deadline (and any lock descriptors the command inherits): `timeout` stops the command at expiry, then,
 * whenever the command ends, every descendant left in the group is killed so none keeps those descriptors. */
export function underDeadline(timeoutMs: number, file: string, args: readonly string[]): [string, string[]] {
  return ['/bin/sh', ['-c', 'timeout --foreground --signal=TERM --kill-after=0.25s "$@"; status=$?; '
    + 'while pkill --signal KILL --ignore-ancestors --pgroup $$; do :; done; exit $status',
  'deadline', `${timeoutMs / 1000}s`, file, ...args]]
}
