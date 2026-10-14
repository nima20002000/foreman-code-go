import type { CiHostReply, CiHostRequest, CiHostStatus } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const FRESHNESS_MS = 5000

interface StatusSnapshot {
  at: number
  status?: CiHostStatus
  pending?: Promise<CiHostReply>
}

/** Planning reuses readiness; slot reservations are still read separately from the database. */
export class CiPlanningSnapshot implements HostCiEndpoint {
  private fleet: { at: number; computers: HostCiComputer[] } | undefined
  private fleetPending: Promise<HostCiComputer[]> | undefined
  private readonly statuses = new Map<string, StatusSnapshot>()

  constructor(private readonly endpoint: HostCiEndpoint) {}

  observeComputers(computers: HostCiComputer[]) {
    this.fleet = { at: Date.now(), computers }
    const keys = new Set(computers.map(computer => canonicalJson(computer)))
    for (const key of this.statuses.keys()) {
      if (!keys.has(key)) this.statuses.delete(key)
    }
  }

  observeStatus(computer: HostCiComputer, reply: CiHostReply) {
    if (reply.operation === 'status') {
      this.statuses.set(canonicalJson(computer), { at: Date.now(), status: reply })
    } else if (reply.run.state === 'failed' || reply.run.state === 'lost') {
      this.invalidate(computer)
    }
  }

  invalidate(computer: HostCiComputer) {
    this.statuses.delete(canonicalJson(computer))
  }

  async computers(): Promise<HostCiComputer[]> {
    if (this.fleet && Date.now() - this.fleet.at < FRESHNESS_MS) return this.fleet.computers
    this.fleetPending ??= this.endpoint.computers().then(computers => {
      this.observeComputers(computers)
      return computers
    }).finally(() => { this.fleetPending = undefined })
    return this.fleetPending
  }

  async request(computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> {
    if (request.operation !== 'status') return this.endpoint.request(computer, request)
    const key = canonicalJson(computer)
    let snapshot = this.statuses.get(key)
    if (snapshot?.status && Date.now() - snapshot.at < FRESHNESS_MS) return snapshot.status
    if (snapshot?.pending) return snapshot.pending
    snapshot = { at: 0 }
    this.statuses.set(key, snapshot)
    const pending = this.endpoint.request(computer, request).then(reply => {
      if (this.statuses.get(key) === snapshot) this.observeStatus(computer, reply)
      return reply
    }).finally(() => {
      // A failed or invalid status cannot extend an older readiness snapshot.
      if (this.statuses.get(key) === snapshot) this.statuses.delete(key)
    })
    snapshot.pending = pending
    return pending
  }
}
