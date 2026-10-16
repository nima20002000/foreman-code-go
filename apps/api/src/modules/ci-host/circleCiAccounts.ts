import { componentLogger } from '../diagnostics/logger.js'
import type { CloudAccount } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

const log = componentLogger('jobs')
const REFRESH_MS = 10 * 60_000

/** Further CircleCI orgs become CI capacity without configuration: each GitHub organization Main's GitHub login belongs
 * to that has a CircleCI project named like a workspace CI mirror. Orgs are only added; a run started on one must stay
 * readable, and an org that loses its project refuses new starts. */
export class CircleCiAccounts {
  private readonly accounts = new Map<string, CloudAccount>()
  private refreshing: Promise<void> | undefined
  private refreshedAt = Number.NEGATIVE_INFINITY

  constructor(private readonly ports: HostCiPorts, private readonly mirrors: () => Promise<string[]>,
    private readonly added: (account: CloudAccount) => void, private readonly now: () => number = Date.now) {}

  /** Starts a discovery pass unless one ran in the last ten minutes; failures keep the known orgs. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (this.now() - this.refreshedAt < REFRESH_MS) return Promise.resolve()
    this.refreshing = this.discover().catch(error => {
      log.warn({ operation: 'discover CircleCI orgs', err: error }, 'CircleCI org discovery failed; known orgs stay')
    }).finally(() => {
      this.refreshedAt = this.now()
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async discover() {
    const mirrors = await this.mirrors()
    if (!mirrors.length) return
    const primaryOwners = new Set(mirrors.map(mirror => mirror.slice(0, mirror.indexOf('/'))))
    const names = [...new Set(mirrors.map(mirror => mirror.slice(mirror.indexOf('/') + 1)))]
    const owners = (await this.command('gh', ['api', 'user/memberships/orgs', '--paginate',
      '--jq', '.[] | select(.state == "active") | .organization.login'])).split('\n').map(line => line.trim())
      .filter(owner => owner && !primaryOwners.has(owner))
    for (const owner of owners) {
      const found = new Set<string>()
      for (const name of names) if (await this.followed(owner, name)) found.add(name)
      const known = this.accounts.get(owner)
      if (known) {
        known.mirrorNames.clear()
        for (const name of found) known.mirrorNames.add(name)
        continue
      }
      if (!found.size) continue
      const account = { owner, mirrorNames: found }
      this.accounts.set(owner, account)
      log.info({ owner, mirrors: [...found] }, 'CircleCI org added as CI capacity')
      this.added(account)
    }
  }

  private async followed(owner: string, name: string) {
    const result = await this.ports.run('circleci', ['project', 'get', '--project', `gh/${owner}/${name}`, '--json'],
      { timeoutMs: 30_000 })
    if (result.code === 0) return true
    if (/\bproject\.not_found\b|Project not found/.test(result.stderr + result.stdout)) return false
    throw new Error(`CircleCI project lookup for gh/${owner}/${name} failed: ${result.stderr.trim().slice(0, 300)}`)
  }

  private async command(file: string, args: string[]) {
    const result = await this.ports.run(file, args, { timeoutMs: 30_000 })
    if (result.code !== 0) throw new Error(`${file} ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}`)
    return result.stdout
  }
}
