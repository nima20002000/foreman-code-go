import type pg from 'pg'
import { mkdir, opendir, realpath, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { WorkspaceFolderCreateInputSchema, type WorkspaceFolderCreateInput, type ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Folder operations stay inside configured roots and never change harness permissions. */
export class HarnessDirectoryBrowser {
  constructor(private readonly configuredRoots: readonly string[], private readonly pool: pg.Pool) {}
  async create(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderCreateInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderCreateInputSchema.parse(input)
    return new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.create', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async () => {
        let parent: string
        try { parent = await realpath(accepted.parentPath) } catch {
          throw new DomainError('DIRECTORY_UNAVAILABLE', 'The parent folder is unavailable.', 404)
        }
        const roots = await Promise.all(this.configuredRoots.map((root) => realpath(root)))
        if (!isAbsolute(accepted.parentPath) || !roots.some((root) => isInside(root, parent))) {
          throw new DomainError('DIRECTORY_OUTSIDE_ROOT', 'Choose a parent inside an allowed location.', 403)
        }
        const path = resolve(parent, accepted.name)
        try { await mkdir(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('DIRECTORY_EXISTS', 'A folder with this name already exists. Choose another name.', 409)
          throw new DomainError('DIRECTORY_CREATE_FAILED', 'The folder could not be created. Check the parent folder permissions.', 422)
        }
        return { path, name: accepted.name }
      },
    })
  }

  async browse(principal: ManagementPrincipal, input: {
    rootId?: string | undefined
    path?: string | undefined
    cursor?: string | undefined
  }) {
    requireAuthorization(principal, 'harnesses:read')
    requireAuthorization(principal, 'workspace_locations:read')
    const roots = await Promise.all(this.configuredRoots.map(async (path, index) => {
      let canonical: string
      try { canonical = await realpath(path) } catch { throw new DomainError('DIRECTORY_ROOT_UNAVAILABLE', 'An allowed folder is unavailable. Ask the server administrator to check its configured roots.', 503) }
      return { id: String(index), label: basename(canonical) || canonical, path: canonical }
    }))
    if (!roots.length) return { roots, rootId: null, path: null, parent: null, directories: [], nextCursor: null }
    const root = input.rootId ? roots.find((item) => item.id === input.rootId) : roots[0]
    if (!root) throw new DomainError('DIRECTORY_ROOT_INVALID', 'Select one of the allowed server locations.', 400)
    const requested = input.path ?? root.path
    if (!isAbsolute(requested) || !isInside(root.path, resolve(requested))) throw new DomainError('DIRECTORY_OUTSIDE_ROOT', 'That folder is outside the allowed location.', 403)
    let path: string
    try { path = await realpath(requested) } catch { throw new DomainError('DIRECTORY_UNAVAILABLE', 'That folder is unavailable.', 404) }
    if (!isInside(root.path, path)) throw new DomainError('DIRECTORY_OUTSIDE_ROOT', 'That link leaves the allowed location.', 403)
    if (!(await lstat(path)).isDirectory()) throw new DomainError('DIRECTORY_REQUIRED', 'Select a folder.', 400)
    let directory
    try { directory = await opendir(path) } catch { throw new DomainError('DIRECTORY_UNAVAILABLE', 'That folder cannot be opened by this runner.', 403) }
    const candidates: { name: string; path: string }[] = []
    let scanned = 0
    for await (const entry of directory) {
      if (++scanned > 20_000) throw new DomainError('DIRECTORY_TOO_LARGE', 'This folder is too large to browse. Select a more specific approved root.', 422)
      // Symlink targets are not selectable. Native admission must still revalidate accepted roots.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      candidates.push({ name: entry.name, path: resolve(path, entry.name) })
    }
    candidates.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const after = candidates.filter((item) => !input.cursor || item.name > input.cursor)
    const directories = after.slice(0, 100)
    return { roots, rootId: root.id, path, parent: path === root.path ? null : dirname(path), directories,
      nextCursor: after.length > directories.length ? directories.at(-1)!.name : null }
  }
}

/** Trusted server configuration only; browser requests cannot add browse roots. */
export function configuredDirectoryRoots(workspaceRoot: string, raw?: string): string[] {
  if (!raw) return [workspaceRoot]
  let extra: unknown
  try { extra = JSON.parse(raw) } catch { throw new Error('GRAPHQL_HARNESS_DIRECTORY_ROOTS must be a JSON array of absolute folder paths.') }
  if (!Array.isArray(extra) || extra.length > 20 || extra.some((path) => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) {
    throw new Error('GRAPHQL_HARNESS_DIRECTORY_ROOTS must contain at most 20 absolute folder paths.')
  }
  return [...new Set([workspaceRoot, ...extra as string[]].map((path) => resolve(path)))]
}
