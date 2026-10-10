import { join } from 'node:path'
import { CiRuntimeRequestSchema, CiRuntimeWorkerStateSchema, PreparedCiRuntimeSchema,
  type CiRuntimeRequest, type CiRuntimeWorkerState } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ensureCommit, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { prepareCiRuntime } from './ciRuntimePrepare.js'
import { lastCiRuntimeRefresh, scheduleCiRuntimeRefresh } from './ciRuntimeRefresh.js'
import { readCiInstalledStorage } from './ciInstalledStorage.js'
import { ciPreparationLimits } from './ciPreparationLimits.js'
import { readCiManagedSetup } from './ciRuntimeInstallation.js'

export interface CiRuntimeWorkerPorts {
  git: GitWorktreePorts
  /** This build computer's managed runtime root; the installer workspace lives inside it. */
  managedRuntimeRoot(): Promise<string>
  prepare: typeof prepareCiRuntime
  refresh(input: Omit<Parameters<typeof scheduleCiRuntimeRefresh>[0], 'drain'>): ReturnType<typeof scheduleCiRuntimeRefresh>
  lastRefresh: typeof lastCiRuntimeRefresh
  /** Paths the current protected runtime configuration references. */
  currentRuntimePaths(stateDirectory: string): Promise<string[]>
  now(): Date
}

/** One CI runtime preparation at a time on this build computer; Main follows it with `status`. */
export class CiRuntimeWorker {
  private state: CiRuntimeWorkerState | undefined
  private preparation: Promise<void> | undefined
  /** `lifetime` is the Worker's, not a request's: preparation outlives the call that started it. */
  constructor(private readonly stateDirectory: string, private readonly ports: CiRuntimeWorkerPorts,
    private readonly lifetime: AbortSignal) {
  }

  async handle(raw: unknown): Promise<CiRuntimeWorkerState> {
    const request = CiRuntimeRequestSchema.parse(raw)
    if (request.operation === 'status') {
      const managedSetup = await readCiManagedSetup(this.stateDirectory)
      const installedStorage = managedSetup?.state === 'failed' ? null : await readCiInstalledStorage(this.stateDirectory)
      return { ...await this.status(), installedStorage, ...(managedSetup ? { managedSetup } : {}) }
    }
    const managedSetup = await readCiManagedSetup(this.stateDirectory)
    if (managedSetup && managedSetup.state !== 'ready') {
      throw new DomainError('CI_RUNTIME_SETUP_REQUIRED', managedSetup.message ?? 'Managed CI storage is unavailable.', 409)
    }
    this.lifetime.throwIfAborted()
    if (request.operation === 'prepare') return this.prepare(request)
    return this.refresh(request)
  }

  private async status(): Promise<CiRuntimeWorkerState> {
    if (this.state) return this.state
    // A fresh Worker process: report how the refresh that restarted it ended.
    const last = await this.ports.lastRefresh(this.stateDirectory)
    return this.set({ operationId: last?.operationId ?? null, state: last && !last.ok ? 'failed' : 'idle',
      commit: last?.commit ?? null, stage: last ? 'refresh' : null,
      prepared: null, message: last && !last.ok ? `The runtime refresh failed: ${last.log}` : null })
  }

  private async prepare(request: Extract<CiRuntimeRequest, { operation: 'prepare' }>) {
    if (this.state?.state === 'preparing' || this.state?.state === 'refreshing') {
      if (this.state.operationId === request.operationId && this.state.commit === request.commit) return this.state
      throw new DomainError('CI_RUNTIME_BUSY', 'This computer is already preparing its CI runtime for another commit.', 409)
    }
    if (this.state?.state === 'prepared' && this.state.operationId === request.operationId
      && this.state.commit === request.commit) return this.state
    const state = this.set({ operationId: request.operationId, state: 'preparing', commit: request.commit,
      stage: 'fetch-source', prepared: null, message: null, preparationLimits: ciPreparationLimits() })
    this.preparation = (async () => {
      const repository = await ensureCommit(this.ports.git, request.repository, request.commit, this.lifetime).catch(error => {
        this.lifetime.throwIfAborted()
        throw new DomainError('COMPUTER_GITHUB_REQUIRED', `This computer could not fetch ${request.repository} from GitHub. `
          + 'Connect GitHub on this computer (computer_github_login_start), then retry.', 409, { cause: error instanceof Error ? error.message : String(error) })
      })
      this.lifetime.throwIfAborted()
      const installer = join(await this.ports.managedRuntimeRoot(), 'installer')
      const keepPaths = await this.ports.currentRuntimePaths(this.stateDirectory)
      this.lifetime.throwIfAborted()
      const prepared = await this.ports.prepare({ repository, commit: request.commit,
        installer, review: request.review, keepImages: request.keepImages, keepPaths,
        signal: this.lifetime,
        log: stage => {
          this.lifetime.throwIfAborted()
          if (this.state?.commit === request.commit) this.set({ ...this.state, stage })
        } })
      this.lifetime.throwIfAborted()
      this.set({ operationId: request.operationId, state: 'prepared', commit: request.commit,
        stage: null, prepared: PreparedCiRuntimeSchema.parse(prepared), message: null,
        preparationLimits: state.preparationLimits! })
    })().catch(error => {
      this.set({ operationId: request.operationId, state: 'failed', commit: request.commit,
        stage: this.state?.stage ?? null, prepared: null,
        preparationLimits: state.preparationLimits!,
        message: (error instanceof Error ? error.message : String(error)).slice(-2000) })
    })
    return state
  }

  async close(): Promise<void> {
    await this.preparation
  }

  private async refresh(request: Extract<CiRuntimeRequest, { operation: 'refresh' }>) {
    if (this.state?.state === 'refreshing' && this.state.operationId === request.operationId
      && this.state.commit === request.commit) return this.state
    const prepared = this.state?.state === 'prepared' ? this.state.prepared : null
    if (!prepared || prepared.commit !== request.commit || this.state?.operationId !== request.operationId) {
      throw new DomainError('CI_RUNTIME_NOT_PREPARED', 'Prepare this commit on the computer before refreshing its runtime.', 409)
    }
    const state = this.set({ ...this.state!, state: 'refreshing', stage: 'draining' })
    try {
      await this.ports.refresh({ operationId: request.operationId, stateDirectory: this.stateDirectory,
        prepared, root: request.root, manifest: request.manifest, resources: request.resources })
      return this.set({ ...state, stage: 'restart' })
    } catch (error) {
      this.set({ ...state, state: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(-2000) })
      throw error
    }
  }

  private set(value: Omit<CiRuntimeWorkerState, 'updatedAt'>) {
    this.state = CiRuntimeWorkerStateSchema.parse({ ...value, updatedAt: this.ports.now().toISOString() })
    return this.state
  }
}
