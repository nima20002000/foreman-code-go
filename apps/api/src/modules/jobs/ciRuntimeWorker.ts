import { CiRuntimeSourceReceiver } from './ciRuntimeSource.js'
import { join } from 'node:path'
import { CiRuntimeRequestSchema, CiRuntimeWorkerStateSchema, PreparedCiRuntimeSchema,
  type CiRuntimeRequest, type CiRuntimeWorkerState } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ensureCommit, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { prepareCiRuntime } from './ciRuntimePrepare.js'
import { lastCiRuntimeRefresh, scheduleCiRuntimeRefresh } from './ciRuntimeRefresh.js'

export interface CiRuntimeWorkerPorts {
  git: GitWorktreePorts
  /** This build computer's managed runtime root; the installer workspace lives inside it. */
  managedRuntimeRoot(): Promise<string>
  prepare: typeof prepareCiRuntime
  refresh: typeof scheduleCiRuntimeRefresh
  lastRefresh: typeof lastCiRuntimeRefresh
  /** Paths the current protected runtime configuration references. */
  currentRuntimePaths(stateDirectory: string): Promise<string[]>
  now(): Date
}

/** One CI runtime preparation at a time on this build computer; Main follows it with `status`. */
export class CiRuntimeWorker {
  private readonly sources: CiRuntimeSourceReceiver
  private state: CiRuntimeWorkerState | undefined
  /** `lifetime` is the Worker's, not a request's: preparation outlives the call that started it. */
  constructor(private readonly stateDirectory: string, private readonly ports: CiRuntimeWorkerPorts,
    private readonly lifetime: AbortSignal) {
    this.sources = new CiRuntimeSourceReceiver(ports.git, lifetime)
  }

  async handle(raw: unknown): Promise<CiRuntimeWorkerState> {
    const request = CiRuntimeRequestSchema.parse(raw)
    if (request.operation === 'status') return this.status()
    if (request.operation === 'source') {
      if (this.state?.state === 'preparing' || this.state?.state === 'refreshing') {
        throw new DomainError('CI_RUNTIME_BUSY', 'This computer is already preparing its CI runtime.', 409)
      }
      await this.sources.receive(request)
      return this.status()
    }
    if (request.operation === 'prepare') return this.prepare(request)
    return this.refresh(request)
  }

  private async status(): Promise<CiRuntimeWorkerState> {
    if (this.state) return this.state
    // A fresh Worker process: report how the refresh that restarted it ended.
    const last = await this.ports.lastRefresh(this.stateDirectory)
    return this.set({ state: last && !last.ok ? 'failed' : 'idle', commit: last?.commit ?? null, stage: last ? 'refresh' : null,
      prepared: null, message: last && !last.ok ? `The runtime refresh failed: ${last.log}` : null })
  }

  private async prepare(request: Extract<CiRuntimeRequest, { operation: 'prepare' }>) {
    if (this.sources.active) {
      throw new DomainError('CI_RUNTIME_BUSY', 'This computer is receiving approved source for runtime preparation.', 409)
    }
    if (this.state?.state === 'preparing' || this.state?.state === 'refreshing') {
      if (this.state.commit === request.commit) return this.state
      throw new DomainError('CI_RUNTIME_BUSY', 'This computer is already preparing its CI runtime for another commit.', 409)
    }
    if (this.state?.state === 'prepared' && this.state.commit === request.commit) return this.state
    const state = this.set({ state: 'preparing', commit: request.commit, stage: 'fetch-source', prepared: null, message: null })
    void (async () => {
      const repository = await ensureCommit(this.ports.git, request.repository, request.commit, this.lifetime)
      const prepared = await this.ports.prepare({ repository, commit: request.commit,
        installer: join(await this.ports.managedRuntimeRoot(), 'installer'), review: request.review, keepImages: request.keepImages,
        keepPaths: await this.ports.currentRuntimePaths(this.stateDirectory),
        log: stage => { if (this.state?.commit === request.commit) this.set({ ...this.state, stage }) } })
      this.set({ state: 'prepared', commit: request.commit, stage: null, prepared: PreparedCiRuntimeSchema.parse(prepared), message: null })
    })().catch(error => {
      this.set({ state: 'failed', commit: request.commit, stage: this.state?.stage ?? null, prepared: null,
        message: (error instanceof Error ? error.message : String(error)).slice(-2000) })
    })
    return state
  }

  private async refresh(request: Extract<CiRuntimeRequest, { operation: 'refresh' }>) {
    const prepared = this.state?.state === 'prepared' ? this.state.prepared : null
    if (!prepared || prepared.commit !== request.commit) {
      throw new DomainError('CI_RUNTIME_NOT_PREPARED', 'Prepare this commit on the computer before refreshing its runtime.', 409)
    }
    await this.ports.refresh({ stateDirectory: this.stateDirectory, prepared, root: request.root, manifest: request.manifest,
      resources: request.resources })
    return this.set({ ...this.state!, state: 'refreshing', stage: 'restart' })
  }

  private set(value: Omit<CiRuntimeWorkerState, 'updatedAt'>) {
    this.state = CiRuntimeWorkerStateSchema.parse({ ...value, updatedAt: this.ports.now().toISOString() })
    return this.state
  }
}
