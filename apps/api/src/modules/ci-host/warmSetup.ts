import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Cache copies have independent inodes so builds cannot mutate another job's dependencies. */
export function warmPnpmInstall(source: string, cache: string, run: string): string[] {
  const lockfile = readFileSync(join(source, 'pnpm-lock.yaml'))
  const lock = createHash('sha256').update(process.version).update(lockfile).digest('hex')
  const inputs = createHash('sha256').update(lock)
  for (const name of ['.npmrc', 'pnpm-workspace.yaml']) {
    if (existsSync(join(source, name))) inputs.update(name).update(readFileSync(join(source, name)))
  }
  const modules = join(cache, 'modules', inputs.digest('hex'))
  const ready = join(cache, 'locks', `${lock}.ready`)
  const install = `corepack pnpm install --frozen-lockfile --store-dir ${shellQuote(join(cache, 'pnpm-store'))}`
    + ` --cache-dir ${shellQuote(join(cache, 'pnpm-metadata'))}`
    + ' --package-import-method=hardlink'
  return [
    `mkdir -p ${shellQuote(join(cache, 'locks'))} ${shellQuote(join(cache, 'modules'))}`,
    `exec {cache_lock}>${shellQuote(join(cache, 'locks', `${lock}.lock`))}`,
    'flock "$cache_lock" || finish $?',
    `modules=${shellQuote(modules)}`,
    'if [ -d "$modules" ]; then cp -a --reflink=auto "$modules/." . || finish $?; fi',
    `${install} --offline || {`,
    '  code=$?',
    `  if [ -f ${shellQuote(ready)} ]; then finish "$code"; fi`,
    `  echo '[ci-cache] filling store for a new lockfile'`,
    `  ${install} || finish $?`,
    '}',
    `touch ${shellQuote(ready)}`,
    'if [ ! -d "$modules" ]; then',
    `  snapshot=${shellQuote(join(run, 'modules'))}`,
    '  mkdir -p "$snapshot" || finish $?',
    '  while IFS= read -r -d "" directory; do',
    '    mkdir -p "$snapshot/$(dirname "$directory")" || finish $?',
    '    cp -a --reflink=auto "$directory" "$snapshot/$directory" || finish $?',
    '  done < <(find . -type d -name node_modules -prune -print0)',
    '  mv "$snapshot" "$modules" || finish $?',
    '  while IFS= read -r -d "" directory; do rm -rf "$directory"; done < <(find . -type d -name node_modules -prune -print0)',
    '  cp -a --reflink=auto "$modules/." . || finish $?',
    'fi',
    'flock -u "$cache_lock"',
    'exec {cache_lock}>&-',
  ]
}
