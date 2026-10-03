import { constants } from 'node:fs'
import { open, mkdir, realpath, readFile, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { SourceError } from './manifest.js'
import { DomainError } from '../errors.js'

export const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
export function anchored(handle: FileHandle, name = ''): string { return `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}` }
export async function identity(handle: FileHandle): Promise<{ device: string; inode: string; mountId: string }> {
  const stat = await handle.stat({ bigint: true })
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8')
  const mountId = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1]
  if (!mountId) throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'Linux mount identity cannot be qualified.', 422)
  return { device: stat.dev.toString(), inode: stat.ino.toString(), mountId }
}
/** Linux procfs anchors every operation to an open directory, including ancestors.
 * The app-private root must exclude other principals; same-UID hostile processes
 * are outside this filesystem qualification, not secured by leaf O_NOFOLLOW.
 */
export async function openPrivateRoot(path: string, privateOnly = true): Promise<FileHandle> {
  if (process.platform !== 'linux' || !isAbsolute(path) || path !== await realpath(path))
    throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'An approved canonical Linux private root is required.', 422)
  let parent = await open('/', directoryFlags)
  try {
    for (const component of path.split('/').filter(Boolean)) {
      const ancestor = await parent.stat()
      if ((ancestor.uid !== 0 && ancestor.uid !== process.getuid?.())
        || ((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0))
        throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'Root ancestors must exclude replacement by other principals.', 422)
      const child = await open(anchored(parent, component), directoryFlags)
      if ((ancestor.mode & 0o022) !== 0 && (await child.stat()).uid !== process.getuid?.()) {
        await child.close(); throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'Sticky-directory entries must be owned by this worker.', 422)
      }
      await parent.close(); parent = child
    }
    const stat = await parent.stat()
    if (stat.uid !== process.getuid?.() || (privateOnly ? (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700 : (stat.mode & 0o022) !== 0 || (stat.mode & 0o500) !== 0o500))
      throw new SourceError('SOURCE_ROOT_NOT_PRIVATE', privateOnly ? 'The approved root must be owned by this worker with mode 0700.' : 'The approved base must be worker-owned and protected from other writers.')
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
  try {
    const parentIdentity = await identity(parent), childIdentity = await identity(child)
    if (parentIdentity.device !== childIdentity.device || parentIdentity.mountId !== childIdentity.mountId)
      throw new SourceError('SOURCE_MOUNT_CHANGED', 'Source entries cannot cross a filesystem or mount boundary.')
    return child
  } catch (error) { await child.close(); throw error }
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
