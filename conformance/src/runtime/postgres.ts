import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CommandError, runCommand, startProcess, waitUntilReady, type ManagedProcess } from './commands.js'
import { randomLoopbackPort } from './ports.js'

export interface FreshPostgres {
  databaseUrl: string
  password: string
  close(): Promise<void>
}

export async function startPostgres(options: {
  directory: string
  environment: NodeJS.ProcessEnv
  binaryDirectory?: string
}): Promise<FreshPostgres> {
  if (process.getuid?.() === 0) {
    throw new Error('Fresh PostgreSQL requires an unprivileged CI job user; conformance does not change user or permissions')
  }
  const commandOptions = { cwd: options.directory, environment: options.environment }
  const binaryDirectory = options.binaryDirectory ?? await runCommand('pg_config', ['--bindir'], commandOptions)
  if (!isAbsolute(binaryDirectory)) throw new Error('PostgreSQL binary directory must be absolute')
  const executable = (name: string) => join(binaryDirectory, name)
  const root = join(options.directory, 'postgres')
  const data = join(root, 'data')
  const sockets = join(root, 'sockets')
  await mkdir(sockets, { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  const passwordFile = join(root, 'password')
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600, flag: 'wx' })
  const username = 'foreman_conformance'
  await runCommand(executable('initdb'), ['--pgdata', data, '--username', username,
    '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--encoding=UTF8', '--no-locale',
    '--pwfile', passwordFile], { ...commandOptions, secrets: [password] })
  const port = await randomLoopbackPort()
  const environment = { ...options.environment, PGPASSWORD: password, PGCONNECT_TIMEOUT: '2' }
  const connection = ['--host', '127.0.0.1', '--port', String(port), '--username', username]
  const postgres = startProcess(executable('postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(port),
    '-k', sockets], { ...commandOptions, secrets: [password] })
  try {
    await waitForPostgres(postgres, executable('pg_isready'), connection, { cwd: root, environment })
    // This is infrastructure ownership verification, never a scenario effect assertion.
    const actualData = await runCommand(executable('psql'), [...connection, '--dbname', 'postgres',
      '--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SHOW data_directory'],
    { cwd: root, environment, secrets: [password] })
    if (await realpath(actualData) !== await realpath(data)) {
      throw new Error('Fresh PostgreSQL ownership verification failed')
    }
    const database = `foreman_conformance_${randomUUID().replaceAll('-', '')}`
    await runCommand(executable('createdb'), [...connection, '--maintenance-db', 'postgres', database],
      { cwd: root, environment, secrets: [password] })
    return {
      databaseUrl: `postgresql://${username}:${password}@127.0.0.1:${port}/${database}`,
      password,
      close: () => postgres.stop(),
    }
  } catch (error) {
    try { await postgres.stop() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PostgreSQL startup and cleanup failed') }
    throw error
  }
}

async function waitForPostgres(
  process: ManagedProcess,
  command: string,
  connection: string[],
  options: { cwd: string; environment: NodeJS.ProcessEnv },
): Promise<void> {
  await waitUntilReady(process, async () => {
    try {
      await runCommand(command, [...connection, '--dbname', 'postgres', '--timeout', '1'],
        { ...options, timeoutMs: 2000 })
      return true
    } catch (error) {
      // pg_isready exit 1/2 means the owned server has not reached TCP readiness yet.
      if (error instanceof CommandError && (error.exitCode === 1 || error.exitCode === 2)) return false
      throw error
    }
  }, 'PostgreSQL', 30_000)
}
