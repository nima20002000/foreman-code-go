import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { ApprovedRootAllowlist, WorkspaceRootSelection, WorkspaceRootPolicy, WorkspaceRootAttestation, WorkspaceRootBrowseResult } from '@graphql/contracts/workspace-root-policies'
export interface AuthorizedWorkspaceRoot {
  selection: WorkspaceRootSelection; allowlist: ApprovedRootAllowlist; ownerPrincipalId: string
  registration: WorkspaceRootPolicy['registration']
}
/** C supplies existing commands/HTTP/MCP around this one generic root authority. */
export interface WorkspaceRootPolicyPort {
  list(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, workspaceId: string): Promise<{ workspaceId: string; policies: WorkspaceRootPolicy[]; allowlists: ApprovedRootAllowlist[]; readiness: 'metadata-only' }>
  authorize(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, selection: WorkspaceRootSelection): Promise<AuthorizedWorkspaceRoot>
  attest(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  browse(root: AuthorizedWorkspaceRoot, relativePath: string): Promise<WorkspaceRootBrowseResult>
  fence(sql: Pick<pg.PoolClient, 'query'>, root: AuthorizedWorkspaceRoot): Promise<void>
  bind(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot, attestation: WorkspaceRootAttestation, nextLocationRevision: number): Promise<WorkspaceRootPolicy>
  resolve(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal,
    selection: { workspaceId: string; hostRef: WorkspaceRootPolicy['hostRef']; rootPolicyId: string; rootPolicyRevision: string; locationRevision: string }): Promise<WorkspaceRootPolicy>
  read(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, workspaceId: string): Promise<WorkspaceRootPolicy[]>
}
export interface WorkspaceRootHostPort {
  /** Main SQL authority calls W07's existing device/main authorizer before host I/O. */
  authorize(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, host: ApprovedRootAllowlist['hostRef'], installationId: string): Promise<WorkspaceRootPolicy['registration']>
  /** Persisted human-approved host configuration only; no probe/browse on list. */
  configurations(sql: Pick<pg.PoolClient, 'query'>, workspaceId: string): Promise<ApprovedRootAllowlist[]>
  attest(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  browse(root: AuthorizedWorkspaceRoot, relativePath: string): Promise<WorkspaceRootBrowseResult>
  sourceNamespace(policy: WorkspaceRootPolicy, rootId: string): Promise<{ canonicalPath: string; filesystem: WorkspaceRootPolicy['filesystem']; attestationId: string; attestationDigest: string }>
}
