import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { apiServiceTemplate, deployProductionApi, publish }
  from '../../../../scripts/local-production-runtime.mjs'
import { renderUserService } from '../../../worker/src/service.mjs'
import { copyApiRuntime } from '../../../../scripts/copy-api-runtime.mjs'
import { readUntil } from './observableCondition.js'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const serviceUser = userInfo()

export async function publishRestartUnit(unitPath: string, service: string) {
  await publish(unitPath, service, 0o600)
}

async function sources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.')) files.push(path)
  }
  return files
}

/** Uses the installer's package layout and unit, with isolated fixture configuration. */
export async function installedRestartService(directory: string, configuration: string,
  environment: NodeJS.ProcessEnv, runtime: string) {
  const app = join(directory, 'installed')
  const release = join(app, 'current')
  const api = join(release, 'apps/api')
  await mkdir(dirname(api), { recursive: true, mode: 0o700 })
  await cp(join(repository, 'scripts'), join(release, 'scripts'), { recursive: true })
  await cp(join(repository, 'packages/contracts/src'), join(release, 'packages/contracts/src'), { recursive: true })
  // Legacy pnpm deployment changes its source workspace's dependency selection.
  const deployment = join(directory, 'deployment-source')
  await mkdir(join(deployment, 'scripts'), { recursive: true, mode: 0o700 })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await copyFile(join(repository, name), join(deployment, name))
  }
  await copyFile(join(repository, 'scripts/require-pnpm.mjs'), join(deployment, 'scripts/require-pnpm.mjs'))
  for (const name of ['api', 'web', 'worker']) {
    await mkdir(join(deployment, 'apps', name), { recursive: true })
    await copyFile(join(repository, 'apps', name, 'package.json'), join(deployment, 'apps', name, 'package.json'))
  }
  await cp(join(repository, 'packages/contracts'), join(deployment, 'packages/contracts'), {
    recursive: true, filter: path => path !== join(repository, 'packages/contracts/node_modules'),
  })
  await deployProductionApi(async (command: string, args: string[]) => {
    // The disposable deployment workspace is discarded, so it needs no dependency restoration.
    if (args.includes('install')) return
    try {
      await execute(command, args, { cwd: deployment, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: 'true', npm_config_offline: 'true' } })
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string; code?: unknown; signal?: unknown }
      throw new Error(`${output.message} (code ${output.code}, signal ${output.signal})\n`
        + `${output.stderr ?? ''}\n${output.stdout ?? ''}`, { cause: error })
    }
  }, api)
  await mkdir(join(api, 'test/helpers'), { recursive: true })
  await copyFile(join(repository, 'apps/api/test/helpers/testPool.mjs'), join(api, 'test/helpers/testPool.mjs'))
  const source = join(repository, 'apps/api/src')
  await cp(source, join(api, 'dist'), { recursive: true, filter: path => !path.endsWith('.ts') })
  for (const path of await sources(source)) {
    const output = join(api, 'dist', relative(source, path).replace(/\.ts$/, '.js'))
    const compiled = ts.transpileModule(await readFile(path, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    } })
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, compiled.outputText)
  }
  await copyApiRuntime(repository, join(api, 'dist'))
  await cp(join(repository, 'apps/worker/src'), join(release, 'apps/worker/src'), { recursive: true })
  await copyFile(join(repository, 'package.json'), join(release, 'package.json'))
  await copyFile(process.execPath, join(release, 'node'))
  await cp(environment.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY!, join(release, 'worker-artifacts'), { recursive: true })
  const fixture = await readFile(new URL('../fixtures/remote-review-main.mjs', import.meta.url), 'utf8')
  await writeFile(join(api, 'dist/restart-fixture.js'),
    fixture.replaceAll('../../src/', './').replaceAll('.ts\'', '.js\''))
  const readyFile = join(directory, 'service-ready.json')
  const preservingFile = `${readyFile}.preserving`
  const unit = `graphql-restart-${randomUUID()}.service`
  const unitPath = join(serviceUser.homedir, '.config/systemd/user', unit)
  const envFile = join(directory, 'service.env')
  const variables = { ...environment, FOREMAN_CODE_RESTART_FIXTURE_READY: readyFile }
  await writeFile(envFile, Object.entries(variables).filter((entry): entry is [string, string] =>
    entry[1] !== undefined).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 })
  const template = apiServiceTemplate('')
    .replace('Wants=\nAfter=\n', '')
    .replaceAll('@HOME@/.config/graphql-production/production.env', envFile)
    .replace('apps/api/dist/server.js', `apps/api/dist/restart-fixture.js ${configuration}`)
    .replace(/^ExecStartPost=.*\n/m, '')
    .replace('Restart=always', 'Restart=no')
  const service = renderUserService(template, { node: join(release, 'node'), app,
    state: directory, home: serviceUser.homedir, path: environment.PATH ?? '/usr/bin:/bin' })
  await publishRestartUnit(unitPath, service)
  const systemctl = (...args: string[]) => execute('systemctl', ['--user', ...args], {
    env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${serviceUser.uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${serviceUser.uid}/bus` },
  })
  await systemctl('daemon-reload')
  const registry = new (await import('../../src/modules/harnesses/recovery/processRegistry.js')).NativeProcessRegistry(
    join(runtime, 'native-process-registry'))
  async function ready() {
    return readUntil(async () => {
      try {
        return JSON.parse(await readFile(readyFile, 'utf8')) as { pid: number; origin: string }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const status = (await systemctl('show', unit, '--property=ActiveState', '--value')).stdout.trim()
        if (status === 'failed' || status === 'inactive') {
          throw new Error(`Installed API startup failed: ${unit}`, { cause: error })
        }
        return undefined
      }
    }, value => value !== undefined, { timeoutMs: 120_000, description: 'installed systemd API startup' })
  }
  return {
    unit, registry,
    state: async () => (await systemctl('show', unit, '--property=ActiveState', '--value')).stdout.trim(),
    pid: async () => Number((await systemctl('show', unit, '--property=MainPID', '--value')).stdout.trim()),
    async start() {
      await rm(readyFile, { force: true })
      await systemctl('start', unit)
      return ready()
    },
    async restart() {
      await rm(readyFile, { force: true })
      await rm(preservingFile, { force: true })
      await systemctl('restart', unit)
      return ready()
    },
    waitForPreservation: () => readUntil(async () => {
      try {
        return await readFile(preservingFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return undefined
      }
    }, value => value === 'preserving', { timeoutMs: 10_000, description: 'Main checking restart preservation' }),
    stop: () => systemctl('stop', unit),
    async close() {
      try {
        await systemctl('stop', unit)
        for (const owner of new Set(registry.snapshot().launches.map(launch => launch.owner))) {
          if (!await registry.closeOwner(owner)) throw new Error('Installed fixture native cleanup is unconfirmed.')
        }
      } finally {
        // A failed assertion can leave native children in this fixture's unit.
        // Kill only that unit after the registry has attempted normal cleanup.
        await systemctl('kill', '--kill-whom=all', '--signal=SIGKILL', unit).catch(error => {
          if (!/not running|not loaded|No such process/.test(String(error.stderr))) throw error
        })
        await rm(unitPath, { force: true })
        await systemctl('daemon-reload')
        await systemctl('reset-failed', unit).catch(error => {
          if (!String(error.stderr).includes('not loaded')) throw error
        })
      }
    },
  }
}
