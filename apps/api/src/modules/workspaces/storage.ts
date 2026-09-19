import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { DomainError } from '../errors.js'

/** Durable project data is separate from application code and harness runtime state. */
export function workspaceStorageRoot(): string {
  return join(homedir(), '.local', 'share', 'graphql', 'workspaces')
}

export function requireWorkspaceStoragePath(root: string, path: string): void {
  const suffix = relative(root, path)
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep)) {
    throw new DomainError('WORKSPACE_LOCATION_OUTSIDE_STORAGE', 'Choose a folder inside the app’s Workspaces location.', 403)
  }
}
