import { chmod, cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

async function copyOptional(source, destination) {
  try {
    await stat(source)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(source, destination, { recursive: true, dereference: true })
}

/** Keep native credentials/configuration, while owning every test-created history and cache. */
export async function withNativeAcceptanceStorage(source, execute) {
  const root = await mkdtemp(join(source.TMPDIR ?? tmpdir(), 'foreman-code-native-'))
  const originalHome = source.HOME ?? homedir()
  const environment = {
    ...source,
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    TMPDIR: join(root, 'tmp'),
    OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
    OPENCODE_DB: join(root, 'data', 'opencode', 'opencode.db'),
  }
  try {
    for (const name of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
      await mkdir(environment[name], { recursive: true, mode: 0o700 })
    }
    const codex = source.CODEX_HOME ?? join(originalHome, '.codex')
    for (const name of ['auth.json', 'config.toml', 'models_cache.json', 'skills', 'plugins']) {
      await copyOptional(join(codex, name), join(environment.CODEX_HOME, name))
    }
    const config = source.OPENCODE_CONFIG_DIR
      ?? join(source.XDG_CONFIG_HOME ?? join(originalHome, '.config'), 'opencode')
    await copyOptional(config, environment.OPENCODE_CONFIG_DIR)
    const data = join(source.XDG_DATA_HOME ?? join(originalHome, '.local', 'share'), 'opencode')
    const auth = join(environment.XDG_DATA_HOME, 'opencode', 'auth.json')
    await copyOptional(join(data, 'auth.json'), auth)
    for (const path of [join(environment.CODEX_HOME, 'auth.json'), auth]) {
      try {
        await chmod(path, 0o600)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return await execute(environment)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
