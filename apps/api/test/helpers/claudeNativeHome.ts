import { chmod, copyFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

/** Keep native test history and caches outside the user's Claude profile. */
export async function withClaudeNativeHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CONFIG_DIR
  const source = previous ?? join(homedir(), '.claude')
  const home = await privateFixtureDirectory('claude-native-home-')
  try {
    for (const name of ['.credentials.json', 'settings.json', '.claude.json']) {
      const destination = join(home, name)
      try {
        await copyFile(join(source, name), destination)
        await chmod(destination, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    process.env.CLAUDE_CONFIG_DIR = home
    return await scenario(home)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
}
