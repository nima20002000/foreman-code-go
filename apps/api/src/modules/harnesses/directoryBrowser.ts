import type pg from 'pg'
import { mkdir, opendir, readdir, realpath, rename, rmdir, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { WorkspaceFolderUndoInputSchema, type WorkspaceFolderUndoInput, WorkspaceFolderCreateInputSchema, WorkspaceFolderCreateResultSchema, WorkspaceFolderRenameInputSchema, type WorkspaceFolderRenameInput, type WorkspaceFolderCreateInput, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { WorkspaceFolderDeleteInputSchema, type WorkspaceFolderDeleteInput } from '@foreman-code/contracts/management'
import { ignoreError } from '../diagnostics/ignoredError.js'

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
    const result = await new PostgresCommandCoordinator(this.pool).execute({
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
        for (let index = 1; index <= 10_000; index++) {
          const name = accepted.name ?? (index === 1 ? 'New folder' : `New folder (${index})`)
          const path = resolve(parent, name)
          try {
            await mkdir(path)
            const identity = await lstat(path, { bigint: true })
            return { path, name, device: String(identity.dev), inode: String(identity.ino) }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              if (!accepted.name) continue
              throw new DomainError('DIRECTORY_EXISTS', 'A folder with this name already exists. Choose another name.', 409)
            }
            throw new DomainError('DIRECTORY_CREATE_FAILED', 'The folder could not be created. Check the parent folder permissions.', 422)
          }
        }
        throw new DomainError('DIRECTORY_NAME_UNAVAILABLE', 'Choose a folder name explicitly.', 409)
      },
    })
    return { value: { path: result.value.path, name: result.value.name }, replayed: result.replayed }
  }

  async renameCreated(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderRenameInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderRenameInputSchema.parse(input)
    const result = await new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.rename', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async (client) => {
        let sourcePath = accepted.path
        if (accepted.creationCommandId) {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`folder-creation:${principal.id}:${accepted.creationCommandId}`])
        const receipt = await client.query<{ result: unknown }>(
          "select result from management_command_receipts where principal_id=$1 and operation='workspace.folder.create' and command_id=$2",
          [principal.id, accepted.creationCommandId],
        )
        if (!receipt.rows[0]) throw new DomainError('DIRECTORY_CREATION_REQUIRED', 'Only a folder created by this caller can be renamed here.', 403)
        const created = WorkspaceFolderCreateResultSchema.shape.value.strip().parse(receipt.rows[0].result)
        const previous = await client.query<{ operation: string; result: { path: string } }>("select operation, result from management_command_receipts where principal_id=$1 and operation in ('workspace.folder.rename', 'workspace.folder.undo') and result->>'creationCommandId'=$2 order by created_at desc limit 1",
          [principal.id, accepted.creationCommandId])
        if (previous.rows[0]?.operation === 'workspace.folder.undo') throw new DomainError('DIRECTORY_ALREADY_UNDONE', 'Folder creation has been undone.', 409)
        sourcePath = previous.rows[0]?.result.path ?? created.path
        }
        const roots = await Promise.all(this.configuredRoots.map((root) => realpath(root)))
        const current = sourcePath && await realpath(sourcePath).catch(ignoreError('harness', 'resolve directory browser source', {}, ['ENOENT', 'ENOTDIR']))
        if (!current || current !== sourcePath || !roots.some((root) => current !== root && isInside(root, current))) {
          throw new DomainError('DIRECTORY_UNAVAILABLE', 'The created folder is no longer available at its original location.', 409)
        }
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${current}`])
        const target = resolve(dirname(current), accepted.name)
        if (target === current) return { path: current, name: accepted.name, creationCommandId: accepted.creationCommandId }
        if ((await readdir(current)).length) throw new DomainError('DIRECTORY_NOT_EMPTY', 'Only an empty folder can be renamed here.', 409)
        // Assignment takes the same folder lock before validation; do not rename a saved destination.
        const references = await client.query("select id from workspaces where execution_location->>'rootPath'=$1", [current])
        const defaults = await client.query("select key from application_settings where record->>'parentPath'=$1", [current])
        if (references.rowCount || defaults.rowCount) throw new DomainError('DIRECTORY_IN_USE', 'This folder is already used by workspace settings.', 409)
        try { await mkdir(target) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('DIRECTORY_EXISTS', 'A folder with this name already exists.', 409)
          throw new DomainError('DIRECTORY_RENAME_FAILED', 'The folder could not be renamed.', 422)
        }
        try { await rename(current, target) } catch {
          await rmdir(target).catch(ignoreError('harness', 'remove rename reservation', { commandId: accepted.commandId, creationCommandId: accepted.creationCommandId }))
          throw new DomainError('DIRECTORY_RENAME_FAILED', 'The folder could not be renamed.', 422)
        }
        return { path: target, name: accepted.name, creationCommandId: accepted.creationCommandId }
      },
    })
    return { value: { path: result.value.path, name: result.value.name }, replayed: result.replayed }
  }

  async undoCreated(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderUndoInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderUndoInputSchema.parse(input)
    const result = await new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.undo', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`folder-creation:${principal.id}:${accepted.creationCommandId}`])
        const receipt = await client.query<{ result: { path: string; device?: string; inode?: string } }>(
          "select result from management_command_receipts where principal_id=$1 and operation='workspace.folder.create' and command_id=$2",
          [principal.id, accepted.creationCommandId])
        const created = receipt.rows[0]?.result
        if (!created?.device || !created.inode) throw new DomainError('DIRECTORY_CREATION_REQUIRED', 'Only a new folder created by this caller can be undone.', 403)
        const undone = await client.query("select 1 from management_command_receipts where principal_id=$1 and operation='workspace.folder.undo' and result->>'creationCommandId'=$2", [principal.id, accepted.creationCommandId])
        if (undone.rowCount) throw new DomainError('DIRECTORY_ALREADY_UNDONE', 'Folder creation has already been undone.', 409)
        const named = await client.query<{ result: { path: string } }>(
          "select result from management_command_receipts where principal_id=$1 and operation='workspace.folder.rename' and result->>'creationCommandId'=$2 order by created_at desc limit 1", [principal.id, accepted.creationCommandId])
        const path = named.rows[0]?.result.path ?? created.path
        const roots = await Promise.all(this.configuredRoots.map((root) => realpath(root)))
        if (await realpath(path).catch(ignoreError('harness', 'resolve created directory', {}, ['ENOENT', 'ENOTDIR'])) !== path || !roots.some((root) => path !== root && isInside(root, path))) {
          throw new DomainError('DIRECTORY_UNAVAILABLE', 'The created folder is no longer available.', 409)
        }
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${path}`])
        const identity = await lstat(path, { bigint: true })
        if (!identity.isDirectory() || String(identity.dev) !== created.device || String(identity.ino) !== created.inode) {
          throw new DomainError('DIRECTORY_CHANGED', 'The original folder has been replaced and cannot be undone.', 409)
        }
        const references = await client.query("select id from workspaces where execution_location->>'rootPath'=$1", [path])
        const defaults = await client.query("select key from application_settings where record->>'parentPath'=$1", [path])
        if (references.rowCount || defaults.rowCount) throw new DomainError('DIRECTORY_IN_USE', 'This folder is already used by workspace settings.', 409)
        try { await rmdir(path) } catch (error) {
          if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new DomainError('DIRECTORY_NOT_EMPTY', 'This folder contains files and cannot be undone.', 409)
          }
          throw new DomainError('DIRECTORY_UNDO_FAILED', 'The folder could not be removed.', 422)
        }
        return { path, creationCommandId: accepted.creationCommandId }
      },
    })
    return { value: { path: result.value.path }, replayed: result.replayed }
  }

  async deleteFolders(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceFolderDeleteInput) {
    requireAuthorization(principal, 'workspace_locations:provision')
    requireAuthorization(principal, 'workspace_locations:read')
    const accepted = WorkspaceFolderDeleteInputSchema.parse(input)
    return new PostgresCommandCoordinator(this.pool).execute({
      principal, source, operation: 'workspace.folder.delete', commandId: accepted.commandId,
      targetKey: 'workspace-folders', payload: accepted,
      perform: async (client) => {
        const roots = await Promise.all(this.configuredRoots.map((root) => realpath(root)))
        const paths = [...accepted.paths].sort()
        for (const path of paths) {
          if (!isAbsolute(path) || !roots.some((root) => path !== root && isInside(root, path))) {
            throw new DomainError('DIRECTORY_OUTSIDE_ROOT', 'Only folders inside workspace storage can be deleted.', 403)
          }
          await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${path}`])
        }
        const deleted: string[] = []
        const failed: { path: string; message: string }[] = []
        for (const path of paths) {
          try {
            if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) {
              throw new Error('This folder is no longer available at its original location.')
            }
            const references = await client.query("select id from workspaces where execution_location->>'rootPath'=$1", [path])
            const defaults = await client.query("select key from application_settings where record->>'parentPath'=$1", [path])
            if (references.rowCount || defaults.rowCount) throw new Error('This folder is used by workspace settings.')
            await rmdir(path)
            deleted.push(path)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            failed.push({ path, message: ['ENOTEMPTY', 'EEXIST'].includes(code ?? '')
              ? 'This folder contains files. Only empty folders can be deleted.'
              : code ? 'This folder could not be deleted.' : error instanceof Error ? error.message : 'This folder could not be deleted.' })
          }
        }
        return { deleted, failed }
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
      return { id: String(index), label: this.configuredRoots.length === 1 ? 'Workspaces' : basename(canonical) || canonical, path: canonical }
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
