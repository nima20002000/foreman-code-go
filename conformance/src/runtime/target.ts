import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'
import type { DeviceTlsTrust } from '@foreman-code/contracts/device-identity'
import { startProcess, waitUntilReady, type ManagedProcess } from './commands.js'
import { createIsolatedEnvironment, type IsolatedEnvironment } from './environment.js'
import { startPostgres, type FreshPostgres } from './postgres.js'
import { randomLoopbackPort } from './ports.js'
import { waitForOwnedProcessesToExit } from './owned-processes.js'
import { issueTestOperatorCredentials, type TestOperatorCredentials } from './credentials.js'
import type { Target } from '../reporting/types.js'

export interface TargetFixtures {
  environment: NodeJS.ProcessEnv
  codexBinary?: string
  codexDirectory?: string
  codexModel?: string
  claudeBinary?: string
  claudeSdkEntrypoint?: string
  deviceEndpoint?: string
  deviceTlsTrust?: DeviceTlsTrust
  close?(): Promise<void>
}

export type TargetFixtureInstaller = (options: {
  directory: string
  environment: NodeJS.ProcessEnv
  apiOrigin: string
  devicePort: number
}) => Promise<TargetFixtures>

export interface TargetSession {
  target: Target
  baseUrl: string
  browserOrigin: string
  directory: string
  environment: NodeJS.ProcessEnv
  operatorToken?: string
  readOnlyOperatorToken?: string
  applicationVersion: string
  codexBinary?: string
  codexDirectory?: string
  codexModel?: string
  claudeBinary?: string
  claudeSdkEntrypoint?: string
  deviceEndpoint?: string
  deviceTlsTrust?: DeviceTlsTrust
  stop(mode?: 'graceful' | 'kill'): Promise<void>
  restart(): Promise<void>
  close(): Promise<void>
}

export interface TargetOptions {
  target: Target
  repoRoot: string
  environment?: NodeJS.ProcessEnv
  goBinary?: string
  tsEntrypoint?: string
  postgresBinaryDirectory?: string
  startupTimeoutMs?: number
  fixtures?: TargetFixtureInstaller
  operatorCredentials?: boolean
  onCleanup?(event: TargetCleanupEvent): void
}

export type TargetCleanupEvent = { type: 'start' } | { type: 'finish'; status: 'passed' | 'failed' }

export function readTarget(environment: NodeJS.ProcessEnv = process.env): Target {
  const target = environment.CONFORMANCE_TARGET ?? 'ts'
  if (target !== 'ts' && target !== 'go') throw new Error('CONFORMANCE_TARGET must be ts or go')
  return target
}

async function targetCommand(options: TargetOptions): Promise<{ executable: string; arguments: string[]; cwd: string }> {
  if (options.target === 'ts') {
    const api = join(options.repoRoot, 'apps/api')
    const entrypoint = options.tsEntrypoint ?? join(api, 'src/server.ts')
    await access(entrypoint, constants.R_OK)
    return {
      executable: process.execPath,
      arguments: ['--import', 'tsx', entrypoint],
      cwd: api,
    }
  }
  const selected = options.goBinary ?? options.environment?.CONFORMANCE_GO_BINARY ?? join(options.repoRoot, 'backend/bin/foreman')
  const executable = isAbsolute(selected) ? selected : resolve(options.repoRoot, selected)
  try { await access(executable, constants.X_OK) }
  catch (error) {
    throw new Error(`Go target binary is unavailable at ${executable}; build backend/cmd/foreman or set CONFORMANCE_GO_BINARY`,
      { cause: error })
  }
  return { executable, arguments: ['serve'], cwd: join(options.repoRoot, 'backend') }
}

async function respondsToHttp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(1000) })
    await response.body?.cancel()
    // A 404 from a partial Go server is a scenario failure, not a launcher crash.
    return true
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) return false
    throw error
  }
}

async function cleanup(
  resources: IsolatedEnvironment,
  database: FreshPostgres | undefined,
  fixtures: TargetFixtures | undefined,
  stopServer: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = []
  try { await stopServer() } catch (error) { failures.push(error) }
  try { await fixtures?.close?.() } catch (error) { failures.push(error) }
  try { await database?.close() } catch (error) { failures.push(error) }
  // Retain owned state if a process could still be using it, with an explicit failure.
  if (failures.length) throw new AggregateError(failures, 'Conformance processes did not cleanly stop')
  await waitForOwnedProcessesToExit(resources.directory)
  await resources.close()
}

export async function startTarget(options: TargetOptions): Promise<TargetSession> {
  const sourceEnvironment = options.environment ?? process.env
  const resources = await createIsolatedEnvironment(options.repoRoot, sourceEnvironment)
  let database: FreshPostgres | undefined
  let fixtures: TargetFixtures | undefined
  let server: ManagedProcess | undefined
  const stop = async (mode: 'graceful' | 'kill' = 'graceful') => {
    if (!server) return
    await server.stop(mode)
    server = undefined
  }
  const closeResources = async () => {
    options.onCleanup?.({ type: 'start' })
    let status: 'passed' | 'failed' = 'failed'
    try {
      await cleanup(resources, database, fixtures, stop)
      status = 'passed'
    } finally {
      options.onCleanup?.({ type: 'finish', status })
    }
  }
  try {
    // Worker enrollment needs the app's version as configuration, not an assertion about source files.
    const packageMetadata = JSON.parse(await readFile(join(options.repoRoot, 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof packageMetadata.version !== 'string' || !packageMetadata.version) {
      throw new Error('The repository application version is unavailable for worker setup')
    }
    const command = await targetCommand({ ...options, environment: sourceEnvironment })
    const binaryDirectory = options.postgresBinaryDirectory ?? sourceEnvironment.CONFORMANCE_POSTGRES_BIN_DIR
    database = await startPostgres({
      directory: resources.directory,
      environment: resources.environment,
      ...(binaryDirectory === undefined ? {} : { binaryDirectory }),
    })
    const port = await randomLoopbackPort()
    let devicePort = await randomLoopbackPort()
    while (devicePort === port) devicePort = await randomLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    const environment = {
      ...resources.environment,
      DATABASE_URL: database.databaseUrl,
      PORT: String(port),
      FOREMAN_CODE_BROWSER_ORIGIN: baseUrl,
    }
    fixtures = await options.fixtures?.({ directory: resources.directory, environment, apiOrigin: baseUrl, devicePort })
    const targetEnvironment = resolveProductEnvironment(fixtures?.environment ?? environment)
    const secrets = [resources.token, database.password, database.databaseUrl]
    let credentials: TestOperatorCredentials | undefined
    if (options.operatorCredentials) {
      credentials = await issueTestOperatorCredentials({
        target: options.target, repoRoot: options.repoRoot, executable: command.executable,
        environment: targetEnvironment,
      })
      secrets.push(credentials.operatorToken, credentials.readOnlyOperatorToken)
    }
    const restart = async () => {
      await stop()
      server = startProcess(command.executable, command.arguments, {
        cwd: command.cwd, environment: targetEnvironment, secrets,
      })
      await waitUntilReady(server, () => respondsToHttp(baseUrl), `${options.target} server`, options.startupTimeoutMs)
    }
    await restart()
    let closed = false
    return {
      target: options.target,
      baseUrl,
      browserOrigin: baseUrl,
      directory: resources.directory,
      environment: targetEnvironment,
      ...(credentials ?? {}),
      applicationVersion: packageMetadata.version,
      ...(fixtures?.codexBinary ? { codexBinary: fixtures.codexBinary } : {}),
      ...(fixtures?.codexDirectory ? { codexDirectory: fixtures.codexDirectory } : {}),
      ...(fixtures?.codexModel ? { codexModel: fixtures.codexModel } : {}),
      ...(fixtures?.claudeBinary ? { claudeBinary: fixtures.claudeBinary } : {}),
      ...(fixtures?.claudeSdkEntrypoint ? { claudeSdkEntrypoint: fixtures.claudeSdkEntrypoint } : {}),
      ...(fixtures?.deviceEndpoint ? { deviceEndpoint: fixtures.deviceEndpoint } : {}),
      ...(fixtures?.deviceTlsTrust ? { deviceTlsTrust: fixtures.deviceTlsTrust } : {}),
      stop,
      restart: async () => {
        if (closed) throw new Error('Cannot restart a closed conformance target')
        await restart()
      },
      close: async () => {
        if (closed) return
        await closeResources()
        closed = true
      },
    }
  } catch (error) {
    try { await closeResources() }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Target setup and cleanup failed', { cause: cleanupError })
    }
    throw error
  }
}
