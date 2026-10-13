import { join } from 'node:path'

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Installs into the checkout's own node_modules from the shared store. A persistent slot already holds the
 * previous part's dependencies, so this is incremental. The workspace's import method (clone-or-copy) keeps the
 * checkout's files independent of the store, so a suite that mutates dependencies cannot corrupt the store. */
export function pnpmInstall(cache: string): string[] {
  const install = `corepack pnpm install --frozen-lockfile --config.confirm-modules-purge=false`
    + ` --store-dir ${shellQuote(join(cache, 'pnpm-store'))} --cache-dir ${shellQuote(join(cache, 'pnpm-metadata'))}`
  return [
    `mkdir -p ${shellQuote(join(cache, 'locks'))}`,
    `exec {cache_lock}>${shellQuote(join(cache, 'locks', 'install.lock'))}`,
    'flock "$cache_lock" || finish $?',
    // Dependency snapshots from the previous per-run copy scheme are no longer read.
    `rm -rf ${shellQuote(join(cache, 'modules'))}`,
    `${install} --offline || {`,
    // A warmed store can still miss metadata (pruned or partial cache); refill it online instead of failing the job.
    `  echo '[ci-cache] filling store online'`,
    `  ${install} || finish $?`,
    '}',
    'flock -u "$cache_lock"',
    'exec {cache_lock}>&-',
  ]
}
