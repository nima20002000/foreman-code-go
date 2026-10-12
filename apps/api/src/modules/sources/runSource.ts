import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { PostgresSourceService } from './service.js'
import { requireAuthorization } from '../access/policy.js'

/** Run Start captures one branch head; all selected computers use that approval. */
export async function prepareRunSources(pool: pg.Pool,
  sources: Pick<PostgresSourceService, 'approveProject' | 'rootGet' | 'bindRoot'>,
  principal: ManagementPrincipal,
  input: { workspaceId: string; commandId: string; source: 'http' | 'mcp'; roots: readonly SourceRootRecord[] },
): Promise<readonly SourceRootRecord[]> {
  requireAuthorization(principal, 'source_roots:bind', { workspaceId: input.workspaceId })
  const command = `run-source:${commandInputHash({ principalId: principal.id, commandId: input.commandId })}`
  const approved = await sources.approveProject(principal, { workspaceId: input.workspaceId, commandId: command }, { source: input.source })
  const manifest = approved.manifest
  const source = { approvedSourceId: manifest.approvedSourceId,
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const refreshed: SourceRootRecord[] = []
  for (const root of input.roots) {
    const bindingCommand = `${command}:${root.binding.rootId}:${root.binding.bindingRevision}`
    const receipt = (await pool.query<{ result: unknown }>(`select result from management_command_receipts
      where principal_id=$1 and operation='source.root.bind' and command_id=$2`,
    [principal.id, bindingCommand])).rows[0]
    if (receipt) {
      const original = SourceRootRecordSchema.parse(receipt.result)
      refreshed.push(await sources.rootGet(principal, input.source, { workspaceId: input.workspaceId,
        rootId: original.binding.rootId, bindingRevision: original.binding.bindingRevision }))
      continue
    }
    const head = (await pool.query<{ current_binding_revision: string }>(
      'select current_binding_revision from source_root_catalog where root_id=$1 and workspace_id=$2',
      [root.binding.rootId, input.workspaceId])).rows[0]
    if (!head) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The selected Run root was not found.', 404)
    const current = await sources.rootGet(principal, input.source, { workspaceId: input.workspaceId,
      rootId: root.binding.rootId, bindingRevision: Number(head.current_binding_revision) })
    if (sameWorkflowValue(current.source, source) && sameWorkflowValue(current.selection, root.selection)
      && current.binding.accessMode === root.binding.accessMode) {
      refreshed.push(current)
      continue
    }
    const bound = await sources.bindRoot(principal, input.source, { workspaceId: input.workspaceId,
      commandId: bindingCommand, expectedBindingRevision: Number(head.current_binding_revision),
      source, selection: root.selection, accessMode: root.binding.accessMode })
    refreshed.push(bound.value)
  }
  return refreshed
}
