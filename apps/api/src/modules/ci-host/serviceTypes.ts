import type { CiHostRequest, CiHostReply, CiHostRun, CiRunRecord, CiUserSystemd } from '@foreman-code/contracts'
import type { CiRepositoryCapabilities } from './repository.js'
import type { CiIntegrationInventory } from './integrationParts.js'
import type { CiUnitInventory } from './parts.js'

export type HostRef = CiRunRecord['computer'] extends infer C ? C extends { hostRef: infer H } ? H : never : never
/** Local dispatch failures can settle before a host records a start. */
export type CiRunSettlement = Omit<CiHostRun, 'startedAt'> & Pick<CiRunRecord, 'startedAt'>
export interface HostCiComputer {
  key: string; hostRef: HostRef; label: string; priority: number
  buildAllowancePercent?: number; userSystemd?: CiUserSystemd
}
export interface HostCiEndpoint {
  /** Paired computers that serve host CI now. */
  computers(): Promise<HostCiComputer[]>
  request(computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply>
}
/** Resolves the commit to test and makes sure GitHub has it, so build computers can fetch it. */
export interface CiCommits {
  infrastructureOnly?(repository: string, commit: string): Promise<boolean>
  branch?(repository: string, defaultBranch: string, commit: string): Promise<string | null>
  isAncestor?(repository: string, ancestor: string, commit: string): Promise<boolean>
  capabilities(repository: string, commit: string): Promise<CiRepositoryCapabilities>
  integrationInventory?(repository: string, commit: string): Promise<CiIntegrationInventory>
  unitInventory?(repository: string, commit: string): Promise<CiUnitInventory>
  resolve(repository: string, defaultBranch: string, commit: string | undefined,
    snapshot: { baseCommit: string; commit: string; bundle: Buffer | null } | null): Promise<string>
}
export type AgentSnapshots = (executionId: string) => Promise<{ baseCommit: string; commit: string; bundle: Buffer | null } | null>
