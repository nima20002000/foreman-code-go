import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { OpenCodeVaultIsolation } from '../../src/modules/harnesses/opencodeFiles/isolation.js'
import type { ManagedOpenCodeServerOptions } from '../../src/modules/harnesses/opencodeTransport.js'
import type { ChildProcessEnvironment } from '../../src/modules/harnesses/port.js'
import { spawnNativeProcess, stopRecoveredChild, type NativeProcessRecovery } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { inheritedAgentEnvironment } from '../../src/modules/harnesses/secrets.js'
import { FixtureServer } from '../opencode-fixtures.js'

/** Provider responses are deterministic; file containment and process closure use the real OS paths. */
export class IsolatedOpenCodeFixture extends FixtureServer {
  readonly ownedFileRoot: string | undefined
  readonly processRecovery: NativeProcessRecovery
  private conversationId: string | undefined
  private starting: Promise<void> | undefined
  private resident: { child: ChildProcessWithoutNullStreams; closed: Promise<void>; isolation: OpenCodeVaultIsolation } | undefined

  constructor(private readonly options: ManagedOpenCodeServerOptions) {
    super()
    this.ownedFileRoot = options.managedFileRoot ? join(options.managedFileRoot, randomUUID()) : undefined
    this.processRecovery = options.processRecovery ?? {
      root: join(options.workingDirectory, '.native-fixture-processes'), owner: `fixture:${randomUUID()}`,
    }
  }

  get nativePid(): number | undefined { return this.resident?.child.pid }

  bindFileConversation(id: string): void {
    if (this.conversationId && this.conversationId !== id) throw new Error('Fixture storage cannot change conversations.')
    this.conversationId = id
  }

  override async ensure(signal?: AbortSignal): Promise<void> {
    await super.ensure(signal)
    if (this.starting) return this.starting
    if (!this.ownedFileRoot || this.resident) return
    const budget = AbortSignal.timeout(10_000)
    this.starting = this.startNamespace(signal ? AbortSignal.any([signal, budget]) : budget)
      .finally(() => { this.starting = undefined })
    await this.starting
  }

  private async startNamespace(signal = AbortSignal.timeout(10_000)): Promise<void> {
    const root = this.options.protectedFileStorageRoot
    const copies = this.options.managedFileRoot
    if (!root || !copies || !this.ownedFileRoot || !this.conversationId) {
      throw new Error('File fixtures require the production vault and conversation-owned materialization paths.')
    }
    await mkdir(this.ownedFileRoot, { recursive: true, mode: 0o700 })
    const isolation = new OpenCodeVaultIsolation(root, { root: copies, owned: this.ownedFileRoot })
    const environment = inheritedAgentEnvironment()
    const launch = await isolation.launch({ binary: process.execPath, args: ['-e', 'process.stdin.resume()'],
      workingDirectory: this.options.workingDirectory, environment }, signal)
    const child = spawnNativeProcess(launch.binary, launch.args, {
      cwd: this.options.workingDirectory, env: environment, recovery: this.processRecovery,
    })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    this.resident = { child, closed, isolation }
    try {
      await new Promise<void>((resolve, reject) => {
        let output = ''
        const finish = (error?: unknown) => {
          signal.removeEventListener('abort', aborted)
          child.stdout.removeListener('data', data)
          child.removeListener('error', failed)
          child.removeListener('exit', exited)
          if (error) reject(error)
          else resolve()
        }
        const aborted = () => finish(signal.reason)
        const failed = (error: Error) => finish(error)
        const exited = () => finish(new Error('The isolated fixture exited before verifying its vault.'))
        const data = (chunk: Buffer) => {
          output += chunk.toString()
          isolation.observe(output)
          if (output.includes('opencode vault ready ') && output.includes('\n')) {
            void isolation.assert(signal).then(() => finish(), finish)
          }
        }
        signal.addEventListener('abort', aborted, { once: true })
        child.once('error', failed)
        child.once('exit', exited)
        child.stdout.on('data', data)
        if (signal.aborted) aborted()
      })
      child.stdout.resume()
      child.stderr.resume()
    } catch (error) {
      try { await this.closeNamespace() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Fixture startup and owned process cleanup failed.', { cause: error }) }
      throw error
    }
  }

  async assertFileSourceIsolation(root: string, signal: AbortSignal): Promise<void> {
    if (root !== this.options.protectedFileStorageRoot) throw new Error('File inspection changed its protected vault.')
    await this.ensure(signal)
    if (!this.resident) throw new Error('The file fixture has no owned isolated process.')
    await this.resident.isolation.assert(signal)
  }

  private async closeNamespace(): Promise<void> {
    const resident = this.resident
    if (!resident) return
    if (!await stopRecoveredChild(resident.child)) throw new Error('Fixture process closure lost its original owner.')
    await resident.closed
    this.resident = undefined
  }

  override async dispose(): Promise<void> {
    try { await super.dispose() }
    finally { await this.closeNamespace() }
  }

  override async restart(environment: ChildProcessEnvironment): Promise<void> {
    await this.closeNamespace()
    await super.restart(environment)
  }

  override async startObservation(): Promise<void> {
    await this.closeNamespace()
    await super.startObservation()
  }
}
