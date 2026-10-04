import { randomUUID } from 'node:crypto'
import { lstat, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'
import { nativeAgentEnvironment } from '../secrets.js'
import { openDirectory } from './host.js'
import { openCodeIsolationHost } from './isolationHost.js'
import { checkFileCondition } from './types.js'

const launcher = '/usr/bin/bwrap'

/** The API retains the vault; the native namespace sees an empty read-only mount.
 * A private procfs prevents reaching the API's vault descriptors through /proc.
 */
export class OpenCodeVaultIsolation {
  private source: { dev: number; ino: number } | undefined
  private ancestors: string[] = []
  private readonly nonce = randomUUID()
  private verified = false

  constructor(readonly root: string, private readonly materializations?: { root: string; owned: string }) {}

  async launch(input: { binary: string; args: string[]; workingDirectory: string; environment: NodeJS.ProcessEnv },
    signal: AbortSignal) {
    signal.throwIfAborted()
    this.verified = false
    checkFileCondition(process.platform === 'linux' && isAbsolute(this.root) && normalize(this.root) === this.root,
      'FILE_SOURCE_ISOLATION_REQUIRED', 'File execution requires a canonical vault on a Linux host.')
    const directory = await openDirectory(this.root)
    try {
      const stat = await directory.stat()
      checkFileCondition(stat.uid === process.geteuid?.() && (stat.mode & 0o077) === 0,
        'FILE_SOURCE_ISOLATION_REQUIRED', 'The API byte vault must remain private and API-owned.')
      this.source = { dev: stat.dev, ino: stat.ino }
    } finally {
      await directory.close()
    }
    const ancestors = new Set<string>()
    for (const protectedRoot of [this.root, ...(this.materializations ? [this.materializations.root] : [])]) {
      for (let parent = dirname(protectedRoot); parent !== '/'; parent = dirname(parent)) ancestors.add(parent)
    }
    this.ancestors = [...ancestors].sort((a, b) => a.split('/').length - b.split('/').length)
    let materialized: { dev: number; ino: number } | undefined
    if (this.materializations) {
      checkFileCondition(dirname(this.materializations.owned) === this.materializations.root
        && isAbsolute(this.materializations.root) && normalize(this.materializations.root) === this.materializations.root,
      'FILE_SOURCE_ISOLATION_REQUIRED', 'Materialized files require one registered native owner directory.')
      const owned = await openDirectory(this.materializations.owned)
      try {
        const stat = await owned.stat()
        materialized = { dev: stat.dev, ino: stat.ino }
      } finally {
        await owned.close()
      }
    }
    const directories = []
    for (const path of this.ancestors) {
      const parent = await openDirectory(path)
      try {
        const stat = await parent.stat()
        directories.push({ path, dev: stat.dev, ino: stat.ino })
      } finally {
        await parent.close()
      }
    }
    const executable = await lstat(launcher)
    checkFileCondition(executable.isFile() && !executable.isSymbolicLink()
      && executable.uid === 0 && (executable.mode & 0o022) === 0,
    'FILE_SOURCE_ISOLATION_REQUIRED', 'File execution requires the system-owned Bubblewrap launcher.')
    signal.throwIfAborted()
    const environment = nativeAgentEnvironment(input.binary, input.workingDirectory, input.environment)
    const namespaces: Record<string, string> = {}
    for (const name of ['mnt', 'pid', 'user']) namespaces[name] = await readlink(`/proc/self/ns/${name}`)
    const hostInput = JSON.stringify({ binary: input.binary, args: input.args, workingDirectory: input.workingDirectory,
      root: this.root, source: this.source,
      ancestors: this.ancestors, directories, namespaces, nonce: this.nonce,
      materializations: this.materializations, materialized })
    return { binary: launcher, args: [
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--disable-userns', '--assert-userns-disabled',
      '--as-pid-1', '--die-with-parent', '--cap-drop', 'ALL',
      '--bind', '/', '/',
      // Mountpoints cannot be renamed to reveal a replacement vault at the old path.
      ...this.ancestors.flatMap((parent) => ['--bind', parent, parent]),
      '--proc', '/proc', '--dev', '/dev', '--setenv', 'PATH', environment.PATH ?? '',
      '--tmpfs', this.root, '--remount-ro', this.root,
      ...(this.materializations ? [
        '--tmpfs', this.materializations.root,
        '--bind', this.materializations.owned, this.materializations.owned,
        '--remount-ro', this.materializations.root,
      ] : []),
      '--', process.execPath, '-e', openCodeIsolationHost, hostInput,
    ] }
  }

  observe(stdout: string): void {
    if (stdout.includes(`opencode vault ready ${this.nonce}\n`)) this.verified = true
  }

  async assert(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    checkFileCondition(this.verified && this.source,
      'FILE_SOURCE_ISOLATION_REQUIRED', 'The native host has not verified the vault namespace.')
    const directory = await openDirectory(this.root)
    try {
      const original = await directory.stat()
      checkFileCondition(original.dev === this.source.dev && original.ino === this.source.ino
        && original.uid === process.geteuid?.() && (original.mode & 0o077) === 0,
      'FILE_SOURCE_ISOLATION_REQUIRED', 'The private API-owned vault must remain unchanged.')
    } finally {
      await directory.close()
    }
    signal.throwIfAborted()
  }
}
