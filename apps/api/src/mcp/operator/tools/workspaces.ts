import type { McpServer } from '@modelcontextprotocol/server'

import {
  HarnessDirectoryBrowseInputSchema, HarnessDirectoryBrowseResultSchema,
  WorkspaceFolderUndoInputSchema, WorkspaceFolderUndoResultSchema,
  WorkspaceFolderCreateInputSchema, WorkspaceFolderCreateResultSchema, WorkspaceFolderRenameInputSchema, WorkspaceFolderRenameResultSchema,
  WorkspaceBatchArchiveInputSchema, WorkspaceBatchArchiveResultSchema,
  WorkspaceArchiveInputSchema, WorkspaceCreateInputSchema, WorkspaceGetInputSchema,
  WorkspaceListInputSchema, WorkspaceUpdateInputSchema,
  WorkspaceStorageFoldersListInputSchema, WorkspaceStorageFoldersPageSchema,
  WorkspaceStorageFolderDeleteInputSchema, WorkspaceStorageFolderDeleteResultSchema,
  ManagedWorkspaceCommandResultSchema, ManagedWorkspacePageSchema, ManagedWorkspaceSchema,
  WorkspaceLocationSetInputSchema, WorkspaceLocationSetResultSchema,
  WorkspaceLocationValidateInputSchema, WorkspaceLocationValidationSchema,
} from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'
import { WorkspaceFolderDeleteInputSchema, WorkspaceFolderDeleteResultSchema } from '@graphql/contracts/management'

export function registerWorkspaceTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'workspace_storage_folders_list')) server.registerTool('workspace_storage_folders_list', {
    description: 'List one page of direct-child workspace folders in the app’s Workspaces storage location, including identity and deletion status/reason. Exact active registered destinations are deduplicated against workspace_list; other referenced folders remain visible with protected deletion state. Folder ownership, archived references, active runs and defaults prevent deletion; symlinks are excluded. Reads never register workspaces. Requires global workspace-read and location-read grants. Pass nextCursor to load more.',
    inputSchema: WorkspaceStorageFoldersListInputSchema, outputSchema: WorkspaceStorageFoldersPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_storage_folders_list', () => context.services.workspaces.storageFolders.list(context.principal, input)))
  if (operatorToolAvailable(context, 'workspace_storage_folder_delete')) server.registerTool('workspace_storage_folder_delete', {
    description: 'Permanently delete an unregistered direct-child workspace folder and ALL its contents. Supply the exact path and expectedIdentity from workspace_storage_folders_list. Never deletes storage roots, registered workspace destinations, active-run locations, defaults or symlinks. Requires global workspaces:archive, workspace_locations:provision and workspace_locations:read. Reuse commandId and the same input after an uncertain result.',
    inputSchema: WorkspaceStorageFolderDeleteInputSchema, outputSchema: WorkspaceStorageFolderDeleteResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_storage_folder_delete', () => context.services.workspaces.storageFolders.delete(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_folders_delete')) server.registerTool('workspace_folders_delete', {
    description: 'Delete selected empty folders inside workspace storage. Never removes the storage root, contents, workspace destinations or defaults. Returns deleted paths and per-folder failures. Reuse commandId and paths after an uncertain result.',
    inputSchema: WorkspaceFolderDeleteInputSchema, outputSchema: WorkspaceFolderDeleteResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_folders_delete', () => context.services.harnessSettings!.directories.deleteFolders(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_folders_list')) server.registerTool('workspace_folders_list', {
    description: 'Browse folders within the app-managed Workspaces location. Never follows links outside an allowed root. Use the returned path as parentPath for workspace_folder_create or workspace_create.',
    inputSchema: HarnessDirectoryBrowseInputSchema, outputSchema: HarnessDirectoryBrowseResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_folders_list', () => context.services.harnessSettings!.directories.browse(context.principal, input)))
  if (operatorToolAvailable(context, 'workspace_folder_undo')) server.registerTool('workspace_folder_undo', {
    description: 'Undo creation of your new empty, unassigned folder, including after naming it. Requires the original creationCommandId. Never deletes contents or arbitrary paths. Reuse commandId on retry.',
    inputSchema: WorkspaceFolderUndoInputSchema, outputSchema: WorkspaceFolderUndoResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_folder_undo', () => context.services.harnessSettings!.directories.undoCreated(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_folder_rename')) server.registerTool('workspace_folder_rename', {
    description: 'Rename an empty, unused folder inside workspace storage. Supply its path, or your creationCommandId to retain creation-undo support across naming. Existing targets are never replaced. Workspace destinations and defaults cannot be renamed. Reuse commandId on retry.',
    inputSchema: WorkspaceFolderRenameInputSchema, outputSchema: WorkspaceFolderRenameResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_folder_rename', () => context.services.harnessSettings!.directories.renameCreated(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_folder_create')) server.registerTool('workspace_folder_create', {
    description: 'Create one new folder; omit name for an available New folder name. Creates inside the app-managed Workspaces location. Requires provisioning and location-read grants. Existing folders are never overwritten. Reuse commandId and input on retry. Does not assign a workspace location or grant harness access.',
    inputSchema: WorkspaceFolderCreateInputSchema, outputSchema: WorkspaceFolderCreateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_folder_create', () => context.services.harnessSettings!.directories.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_list')) server.registerTool('workspace_list', {
    description: 'List one cursor page of authorized workspaces with revisions and archive state. Pass pageInfo.nextCursor as cursor to load more; null means the end.', inputSchema: WorkspaceListInputSchema,
    outputSchema: ManagedWorkspacePageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_list', () => context.services.workspaces.list(context.principal, input)))
  if (operatorToolAvailable(context, 'workspace_get')) server.registerTool('workspace_get', {
    description: 'Read an authorized workspace by stable ID.', inputSchema: WorkspaceGetInputSchema,
    outputSchema: ManagedWorkspaceSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_get', () => context.services.workspaces.get(context.principal, input.workspaceId)))
  if (operatorToolAvailable(context, 'workspace_create')) server.registerTool('workspace_create', {
    description: 'Create a durable workspace. Omit name to use the configured suggested name with an available (1), (2), etc. suffix when a workspace name or project folder is taken. Explicit names reject existing folders. Read workspace_defaults_get and pass its parentPath (or an explicit override) to create the project folder inside app-managed workspace storage and save it as the execution location inherited by all workflows. Folder creation requires workspace_locations:provision, workspace_locations:update and workspace_locations:read with global scope. Omitting parentPath creates an unconfigured workspace. Reuse commandId and the same input on an uncertain retry.', inputSchema: WorkspaceCreateInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_create', () => context.services.workspaces.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_update')) server.registerTool('workspace_update', {
    description: 'Revision-check and rename or describe a workspace.', inputSchema: WorkspaceUpdateInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_update', () => context.services.workspaces.update(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_batch_archive')) server.registerTool('workspace_batch_archive', {
    description: 'Archive 1–100 workspaces and delete their app-created project folders, including contents. Retain workflow/run history and externally selected folders. Requires archive permission and expected revision for every workspace, plus workspace_locations:provision for owned folders. Active runs or conflicts reject the entire archive batch. Folder cleanup follows the database commit; on cleanup failure retry with the same commandId and input.',
    inputSchema: WorkspaceBatchArchiveInputSchema, outputSchema: WorkspaceBatchArchiveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_batch_archive', () => context.services.workspaces.archiveBatch(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_archive')) server.registerTool('workspace_archive', {
    description: 'Archive a settled workspace and delete its app-created project folder, including contents. Retain workflow/run history and externally selected folders. Requires workspaces:archive, plus workspace_locations:provision for an owned folder. On cleanup failure retry with the same commandId and input; the workspace may already be archived.', inputSchema: WorkspaceArchiveInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_archive', () => context.services.workspaces.archive(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_location_validate')) server.registerTool('workspace_location_validate', {
    description: 'Validate an existing runner-owned directory without changing it or starting a harness.',
    inputSchema: WorkspaceLocationValidateInputSchema,
    outputSchema: WorkspaceLocationValidationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_location_validate', () => context.services.locations.validate(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_location_set')) server.registerTool('workspace_location_set', {
    description: 'Revision-check and save an existing canonical workspace execution folder. All workflows inherit it for new runs; accepted runs retain their snapshots. Read workspace_get for expectedLocationRevision. This does not change harness permissions.',
    inputSchema: WorkspaceLocationSetInputSchema,
    outputSchema: WorkspaceLocationSetResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_location_set', () => context.services.locations.set(context.principal, 'mcp', input)))
}
