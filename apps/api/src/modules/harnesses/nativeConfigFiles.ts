import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors.js'

export async function readNativeUserFile(file: string, options: {
  whenMissing?: string
  requireDirectory?: boolean
} = {}): Promise<string> {
  let directory: string
  try { directory = await realpath(dirname(file)) }
  catch (error) {
    if (options.whenMissing !== undefined && !options.requireDirectory
      && (error as NodeJS.ErrnoException).code === 'ENOENT') return options.whenMissing
    throw error
  }
  if (directory !== resolve(dirname(file))) {
    throw new DomainError('MCP_CONFIG_SYMLINK', 'Linked native configuration directories are read-only in this manager.', 409)
  }
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) {
        throw new DomainError('MCP_CONFIG_FILE_UNSAFE', 'The native configuration must be a single regular file under 1 MiB.', 409)
      }
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  } catch (error) {
    if (options.whenMissing !== undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return options.whenMissing
    }
    throw error
  }
}
export async function backupNativeUserFile(file: string, source: string): Promise<void> {
  const handle = await open(`${file}.graphql-mcp-${randomUUID()}.bak`, 'wx', 0o600)
  try {
    await handle.writeFile(source)
    await handle.sync()
  } finally {
    await handle.close()
  }
  // The backup name must survive a crash before the native writer replaces the config.
  await syncNativeConfigDirectory(file)
}
export async function syncNativeConfigDirectory(file: string): Promise<void> {
  const directory = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY)
  try { await directory.sync() } finally { await directory.close() }
}
