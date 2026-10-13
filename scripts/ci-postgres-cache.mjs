import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function ciPostgresCacheDirectory(environment = process.env) {
  if (environment.CI_HOST_RUNNER !== '1' || !environment.FOREMAN_CODE_CI_HOST_RUN_ID) return undefined
  return environment.FOREMAN_CODE_CI_POSTGRES_CACHE ?? join(homedir(), '.cache', 'foreman-ci-postgres')
}

export function ciTemplateCacheDirectory(environment = process.env) {
  if (!ciPostgresCacheDirectory(environment) || !environment.TMPDIR) return undefined
  const marker = join(environment.TMPDIR, 'test-database-template-cache')
  return existsSync(marker) ? readFileSync(marker, 'utf8') : undefined
}
