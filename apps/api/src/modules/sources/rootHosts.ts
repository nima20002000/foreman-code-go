import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  ApprovedRootAllowlistSchema, WorkspaceRootAttestationSchema, WorkspaceRootBrowseResultSchema,
  type ApprovedRootAllowlist, type WorkspaceRootPolicy, type WorkspaceRootWorkerRequest,
} from '@graphql/contracts/workspace-root-policies'
import { DomainError } from '../errors.js'
import { attestWorkspaceRoot, browseApprovedRoot, attestSourceNamespace } from './rootAttestation.js'
import type { AuthorizedWorkspaceRoot, WorkspaceRootHostPort } from './rootPolicyPorts.js'

export interface RootWorkerClient {
  /** W07 existing selected-main authenticated carrier; namespace/version/payload
   * budgets are WORKSPACE_ROOT_EXTENSION, not a second connection system. */
  request(host: ApprovedRootAllowlist['hostRef'], registration: NonNullable<WorkspaceRootPolicy['registration']>, request: WorkspaceRootWorkerRequest): Promise<unknown>
}
export class InstalledWorkspaceRootHosts implements WorkspaceRootHostPort {
  constructor(private readonly main: ApprovedRootAllowlist,
    private readonly authorizeInstallation: (sql: GraphSqlClient, principal: ManagementPrincipal,
      host: ApprovedRootAllowlist['hostRef'], installationId: string) => Promise<WorkspaceRootPolicy['registration']>,
    private readonly remote: RootWorkerClient) { this.main = ApprovedRootAllowlistSchema.parse(structuredClone(main)) }
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal, host: ApprovedRootAllowlist['hostRef'], installationId: string) {
    return this.authorizeInstallation(sql, principal, host, installationId)
  }
  async configurations(sql: GraphSqlClient, _workspaceId: string): Promise<ApprovedRootAllowlist[]> {
    void _workspaceId
    const rows = await sql.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
      join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
      where c.main_id=$1 order by h.host_scope`, [this.main.hostRef.mainId])
    return rows.rows.map(row => ApprovedRootAllowlistSchema.parse(row.record))
  }
  private local(root: AuthorizedWorkspaceRoot): void {
    if (root.selection.hostRef.kind !== 'main' || root.selection.hostRef.mainId !== this.main.hostRef.mainId
      || root.allowlist.applicationInstallationId !== this.main.applicationInstallationId || root.allowlist.configurationRevision !== this.main.configurationRevision)
      throw new DomainError('ROOT_INSTALLATION_CONFLICT', 'The selected root does not belong to the approved main installation.', 409)
  }
  async attest(root: AuthorizedWorkspaceRoot) {
    if (root.selection.hostRef.kind === 'main') { this.local(root); return attestWorkspaceRoot(this.main, root.selection) }
    if (!root.registration) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected device has no current approved registration.', 409)
    return WorkspaceRootAttestationSchema.parse(await this.remote.request(root.selection.hostRef, root.registration,
      { version: 1, operation: 'workspace-roots.attest', selection: root.selection }))
  }
  async browse(root: AuthorizedWorkspaceRoot, relativePath: string) {
    if (root.selection.hostRef.kind === 'main') { this.local(root); return browseApprovedRoot(this.main, root.selection, relativePath) }
    if (!root.registration) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected device has no current approved registration.', 409)
    return WorkspaceRootBrowseResultSchema.parse(await this.remote.request(root.selection.hostRef, root.registration,
      { version: 1, operation: 'workspace-roots.browse', selection: root.selection, relativePath }))
  }
  async sourceNamespace(policy: WorkspaceRootPolicy, _rootId: string) {
    void _rootId
    if (policy.hostRef.kind === 'main') {
      if (policy.hostRef.mainId !== this.main.hostRef.mainId || policy.applicationInstallationId !== this.main.applicationInstallationId)
        throw new DomainError('ROOT_INSTALLATION_CONFLICT', 'Source namespace belongs to another main.', 409)
      return attestSourceNamespace(this.main, policy)
    }
    if (!policy.registration) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected device has no approved source namespace registration.', 409)
    const value = await this.remote.request(policy.hostRef, policy.registration, { version: 1, operation: 'workspace-roots.source-namespace', policy })
    // The source binding service validates canonical path, filesystem and digest
    // through its strict persisted root schema after host authority fences.
    return value as Awaited<ReturnType<typeof attestSourceNamespace>>
  }
}
