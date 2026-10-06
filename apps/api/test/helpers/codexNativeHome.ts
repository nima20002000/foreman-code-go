import { chmod, copyFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

/** Keep native test sessions and caches outside the user's Codex storage. */
export async function withCodexNativeHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.CODEX_HOME
  const source = previous ?? join(homedir(), '.codex')
  const home = await privateFixtureDirectory('codex-native-home-')
  try {
    for (const name of ['auth.json', 'config.toml']) {
      const destination = join(home, name)
      try {
        await copyFile(join(source, name), destination)
        await chmod(destination, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    process.env.CODEX_HOME = home
    return await scenario(home)
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}
