import type { SourceEntry } from '@foreman-code/contracts/source-materialization'
import type { FileHandle } from 'node:fs/promises'
import { entryParent } from './privateFilesystem.js'
import { SourceError, sourcePath } from './manifest.js'

/** Four entries bound buffered file content to 64 MiB, including maximum-size files. */
export async function processSourceEntries<Entry>(
  entries: readonly Entry[],
  work: (entry: Entry) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async () => {
    try {
      while (!failure && next < entries.length) {
        signal?.throwIfAborted()
        const entry = entries[next++]!
        await work(entry)
      }
      signal?.throwIfAborted()
    } catch (error) {
      failure ??= { error }
    }
  }
  // Join outstanding I/O before callers close directory handles or activate a tree.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker))
  if (failure) throw failure.error
  signal?.throwIfAborted()
}

/** Each worker retains one qualified parent and processes one file at a time. */
export async function processSourceDirectories(
  tree: FileHandle,
  entries: readonly SourceEntry[],
  work: (parent: FileHandle, entries: readonly SourceEntry[]) => Promise<void>,
  options: { create?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const directories = new Map<string, SourceEntry[]>()
  for (const entry of entries) {
    const directory = entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
    const group = directories.get(directory) ?? []
    group.push(entry)
    directories.set(directory, group)
  }
  const groups: SourceEntry[][] = []
  for (const directory of directories.values()) {
    const size = Math.min(64, Math.ceil(directory.length / 4))
    for (let offset = 0; offset < directory.length; offset += size) {
      groups.push(directory.slice(offset, offset + size))
    }
  }
  await processSourceEntries(groups, async group => {
    const { parent } = await entryParent(tree, group[0]!.path, options.create ?? false)
    try {
      await work(parent, group)
      if (options.create) await parent.sync()
    } finally { await parent.close() }
  }, options.signal)
}

/** Git emits files in tree order; parents remain open until their last write is joined. */
export async function withSourceTreeWriter<Result>(
  tree: FileHandle,
  paths: readonly string[],
  work: (write: (entry: SourceEntry, bytes: Uint8Array) => Promise<void>) => Promise<Result>,
  writeEntry: (parent: FileHandle, entry: SourceEntry, bytes: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<Result> {
  const expected = new Set(paths.map(sourcePath))
  const directories = new Map<string, {
    remaining: number
    parent?: Promise<FileHandle>
    opened?: FileHandle
  }>()
  for (const path of expected) {
    const name = path.slice(0, path.lastIndexOf('/') + 1)
    const directory = directories.get(name) ?? { remaining: 0 }
    directory.remaining++
    directories.set(name, directory)
  }
  try {
    const result = await work(async (entry, bytes) => {
      signal.throwIfAborted()
      if (!expected.delete(entry.path)) throw new SourceError('SOURCE_PATH_INVALID', 'Unexpected source write.')
      const name = entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
      const directory = directories.get(name)!
      directory.parent ??= entryParent(tree, entry.path, true).then(value => {
        directory.opened = value.parent
        return value.parent
      })
      const parent = await directory.parent
      try {
        await writeEntry(parent, entry, bytes)
      } finally {
        if (--directory.remaining === 0) {
          delete directory.parent
          delete directory.opened
          try { await parent.sync() } finally { await parent.close() }
        }
      }
    })
    signal.throwIfAborted()
    if (expected.size) throw new SourceError('SOURCE_TREE_INVALID', 'Source writes are incomplete.')
    return result
  } finally {
    // The capture joins its writers before returning, including on cancellation.
    const closed = await Promise.allSettled([...directories.values()].map(async directory => {
      if (directory.opened) await directory.opened.close()
    }))
    const failures = closed.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Source directory closure failed.')
  }
}
