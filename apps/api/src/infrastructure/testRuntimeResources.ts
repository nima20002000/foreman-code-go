import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { testResourcesIdentity } from '@graphql/contracts/runtime-identity-node'
import { assertTestPath } from '../../../../scripts/test-resources.mjs'
import type { ApiConfig } from '../config.js'
import { defaultFileStorageRoot } from '../modules/files/storage.js'
import { workspaceStorageRoot } from '../modules/workspaces/storage.js'
import { logFilePath } from './logger.js'

export function readTestResourcesIdentity(config: ApiConfig): string | undefined {
  const environment = process.env
  if (!environment.GRAPHQL_TEST_ROOT && !environment.GRAPHQL_TEST_OWNER) return undefined
  const resource = { directory: environment.GRAPHQL_TEST_ROOT!, token: environment.GRAPHQL_TEST_OWNER! }
  const home = environment.HOME ?? homedir()
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, '.config')
  const logFile = logFilePath(environment)
  const paths = [
    home, configHome,
    environment.XDG_DATA_HOME ?? join(home, '.local/share'),
    environment.XDG_CACHE_HOME ?? join(home, '.cache'),
    environment.XDG_STATE_HOME ?? join(home, '.local/state'),
    environment.XDG_RUNTIME_DIR,
    environment.CODEX_HOME ?? join(home, '.codex'),
    environment.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
    environment.OPENCODE_CONFIG_DIR ?? join(configHome, 'opencode'),
    environment.TMPDIR ?? tmpdir(),
    config.fileStorageRoot ?? defaultFileStorageRoot(),
    config.workspaceStorageRoot ?? workspaceStorageRoot(),
    config.harnesses.workspaceRoot,
    environment.GRAPHQL_API_ENV_FILE,
    ...(logFile ? [dirname(logFile)] : []),
  ]
  for (const path of paths) {
    if (!path) throw new Error('Test API resource paths must be explicitly owned by the invocation')
    assertTestPath(resource, path)
  }
  return testResourcesIdentity(resource.directory, resource.token)
}
