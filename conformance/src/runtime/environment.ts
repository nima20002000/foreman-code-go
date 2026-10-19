import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'

export interface IsolatedEnvironment {
  directory: string
  token: string
  environment: NodeJS.ProcessEnv
  close(): Promise<void>
}

const resourcePaths = {
  HOME: 'home',
  CODEX_HOME: 'home/.codex',
  CLAUDE_CONFIG_DIR: 'home/.claude',
  XDG_CONFIG_HOME: 'home/.config',
  XDG_DATA_HOME: 'home/.local/share',
  XDG_CACHE_HOME: 'home/.cache',
  XDG_STATE_HOME: 'home/.local/state',
  XDG_RUNTIME_DIR: 'runtime',
  FILE_STORAGE_ROOT: 'app/files',
  WORKSPACE_STORAGE_ROOT: 'app/projects',
  HARNESS_WORKSPACE_ROOT: 'app/harnesses',
  FOREMAN_CODE_APP_MCP_DIRECTORY: 'home/.local/share/graphql/mcp',
  LOG_DIR: 'logs',
  TMPDIR: 'tmp',
  TMP: 'tmp',
  TEMP: 'tmp',
} as const

function processEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'production' }
  for (const name of ['PATH', 'SystemRoot', 'WINDIR']) {
    if (source[name] !== undefined) environment[name] = source[name]
  }
  return environment
}

async function isolatedRootParent(repoRoot: string): Promise<string> {
  const parent = await realpath(repoRoot)
  for (const temporary of new Set(['/tmp', '/var/tmp', tmpdir()])) {
    const canonical = await realpath(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(temporary)
      throw error
    })
    const suffix = relative(canonical, parent)
    if (suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)) {
      throw new Error('Conformance requires a source checkout outside system temporary directories')
    }
  }
  return parent
}

async function removeOwnedDirectory(directory: string, token: string): Promise<void> {
  const stat = await lstat(directory)
  const marker = await lstat(join(directory, '.graphql-test-owner.json'))
  const owner = JSON.parse(await readFile(join(directory, '.graphql-test-owner.json'), 'utf8')) as {
    directory?: unknown
    token?: unknown
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== resolve(directory)
    || !marker.isFile() || marker.isSymbolicLink() || stat.uid !== process.getuid?.()
    || marker.uid !== stat.uid || (stat.mode & 0o077) !== 0 || (marker.mode & 0o077) !== 0
    || owner.directory !== directory || owner.token !== token) {
    throw new Error('Conformance resource ownership changed; cleanup refused')
  }
  await rm(directory, { recursive: true })
}

export async function createIsolatedEnvironment(
  repoRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<IsolatedEnvironment> {
  if (process.getuid === undefined) throw new Error('Conformance requires Unix resource ownership support')
  // The real file store excludes system temporary roots. Keep every target resource
  // under one owned checkout child; the short prefix leaves room for PostgreSQL sockets.
  const directory = await mkdtemp(join(await isolatedRootParent(repoRoot), '.fc-'))
  const token = randomUUID()
  await writeFile(join(directory, '.graphql-test-owner.json'), JSON.stringify({ directory, token }),
    { mode: 0o600, flag: 'wx' })
  try {
    const environment = processEnvironment(source)
    for (const [name, relative] of Object.entries(resourcePaths)) {
      environment[name] = join(directory, relative)
      await mkdir(environment[name], { recursive: true, mode: 0o700 })
    }
    const envFile = join(directory, 'api.env')
    await writeFile(envFile, '', { mode: 0o600, flag: 'wx' })
    await copyFile(join(repoRoot, 'scripts/graphql-mcp.mjs'),
      join(environment.FOREMAN_CODE_APP_MCP_DIRECTORY!, 'launcher.mjs'))
    Object.assign(environment, {
      FOREMAN_CODE_API_ENV_FILE: envFile,
      FOREMAN_CODE_TEST_ROOT: directory,
      FOREMAN_CODE_TEST_OWNER: token,
      HOST: '127.0.0.1',
    })
    let closed = false
    return {
      directory,
      token,
      environment: resolveProductEnvironment(environment),
      close: async () => {
        if (closed) return
        await removeOwnedDirectory(directory, token)
        closed = true
      },
    }
  } catch (error) {
    try { await removeOwnedDirectory(directory, token) }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Conformance directory setup and cleanup failed', { cause: cleanupError })
    }
    throw error
  }
}
