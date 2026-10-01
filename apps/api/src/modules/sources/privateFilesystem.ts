import { constants } from 'node:fs'
import { open, mkdir, realpath, readFile, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { SourceError } from './manifest.js'

export const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
export function anchored(handle: FileHandle, name = ''): string { return `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}` }
export async function identity(handle: FileHandle): Promise<{ device: string; inode: string; mountId: string }> {
  const stat = await handle.stat({ bigint: true })
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8')
  const mountId = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1]
  if (!mountId) throw new SourceError('SOURCE_FILESYSTEM_UNSUPPORTED', 'Linux mount identity cannot be qualified.')
  return { device: stat.dev.toString(), inode: stat.ino.toString(), mountId }
}
/** Linux procfs anchors every operation to an open directory, including ancestors.
 * The app-private root must exclude other principals; same-UID hostile processes
 * are outside this filesystem qualification, not secured by leaf O_NOFOLLOW.
 */
export async function openPrivateRoot(path: string): Promise<FileHandle> {
  if (process.platform !== 'linux' || !isAbsolute(path) || path !== await realpath(path))
    throw new SourceError('SOURCE_FILESYSTEM_UNSUPPORTED', 'An approved canonical Linux private root is required.')
  let parent = await open('/', directoryFlags)
  try {
    for (const component of path.split('/').filter(Boolean)) {
      const child = await open(anchored(parent, component), directoryFlags)
      await parent.close(); parent = child
    }
    const stat = await parent.stat()
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700)
      throw new SourceError('SOURCE_ROOT_NOT_PRIVATE', 'The approved root must be owned by this worker with mode 0700.')
    const current = await open(path, directoryFlags)
    try { if (JSON.stringify(await identity(current)) !== JSON.stringify(await identity(parent))) throw new SourceError('SOURCE_ROOT_CHANGED', 'Root changed during validation.') }
    finally { await current.close() }
    return parent
  } catch (error) { await parent.close(); throw error }
}
export async function openChildDirectory(parent: FileHandle, name: string, create = false): Promise<FileHandle> {
  if (create) { try { await mkdir(anchored(parent, name), { mode: 0o700 }) } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error } }
  const child = await open(anchored(parent, name), directoryFlags)
  const stat = await child.stat()
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) { await child.close(); throw new SourceError('SOURCE_DIRECTORY_NOT_PRIVATE', 'Materialization parents must be private worker directories.') }
  return child
}
export async function entryParent(root: FileHandle, path: string, create: boolean): Promise<{ parent: FileHandle; leaf: string }> {
  const components = path.split('/'); const leaf = components.pop()!
  let parent = await open(anchored(root), directoryFlags & ~constants.O_NOFOLLOW)
  try {
    for (const component of components) {
      const child = await openChildDirectory(parent, component, create)
      await parent.close(); parent = child
    }
    return { parent, leaf }
  } catch (error) { await parent.close(); throw error }
}
