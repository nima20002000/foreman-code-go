import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { apiServiceTemplate, deployProductionApi, publish }
  from '../../../../scripts/local-production-runtime.mjs'
import { renderUserService } from '../../../worker/src/service.mjs'
import { copyApiRuntime } from '../../../../scripts/copy-api-runtime.mjs'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { readUntil } from './observableCondition.js'
import { removeRestartUnit } from '../../../../scripts/test-restart-units.mjs'
import { testFixtureCacheRoot } from '../../../../scripts/test-fixture-cache.mjs'
import { ownedTestPath } from './testResources.js'
import { measureIntegrationPhase } from './integrationPhase.js'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const serviceUser = userInfo()
const workerRequire = createRequire(new URL('../../../worker/package.json', import.meta.url))
const { build } = workerRequire('esbuild') as {
  build(options: {
    entryPoints: string[]
    outdir?: string
    outfile?: string
    outbase?: string
    bundle?: boolean
    packages?: 'external'
    plugins?: Array<{
      name: string
      setup(builder: {
        onResolve(options: { filter: RegExp },
          callback: (args: { path: string }) => { path: string; external: boolean }): void
      }): void
    }>
    platform: 'node'
    format: 'esm'
    target: string
    logLevel: 'silent'
  }): Promise<unknown>
}

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
  ownedTestPath(directory)
  const app = join(directory, 'installed')
  const release = join(app, 'current')
  const api = join(release, 'apps/api')
  await mkdir(dirname(api), { recursive: true, mode: 0o700 })
  await cp(join(repository, 'scripts'), join(release, 'scripts'), { recursive: true })
  await cp(join(repository, 'packages/contracts/src'), join(release, 'packages/contracts/src'), { recursive: true })
  // Package from a disposable workspace so fixture setup cannot change the installed source.
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
  // The installer's shared dependency tree is deployed once per lockfile, not copied again for every fixture.
  // The installed API's own modules are transformed below.
  await mkdir(join(deployment, 'apps/api/dist'), { recursive: true })
  const { storeDir } = parse(await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8')) as {
    storeDir: string
  }
  const ciMetadataCache = join(repository, '.logs/pnpm-metadata')
  // Test homes are private; use the host or cloud install's cache for release-age verification.
  const metadataCache = process.env.npm_config_cache_dir
    || (existsSync(ciMetadataCache) ? ciMetadataCache : join(serviceUser.homedir, '.cache/pnpm'))
  const deploy = async (command: string, args: string[]) => {
    // The disposable deployment workspace is discarded, so it needs no dependency restoration.
    if (args.includes('install')) return
    try {
      // Deploy rechecks release age; allow missing full metadata while reusing installed packages.
      await execute(command, [...args, '--prefer-offline', '--store-dir', storeDir, '--cache-dir', metadataCache], {
        cwd: deployment, maxBuffer: 4 * 1024 * 1024, timeout: 300_000,
        env: { ...process.env, CI: 'true' },
      })
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string; code?: unknown; signal?: unknown }
      throw new Error(`Installed API fixture deployment failed (prefer-offline; 300 s command limit): ${output.message}`
        + ` (code ${output.code}, signal ${output.signal})\n`
        + `${output.stderr ?? ''}\n${output.stdout ?? ''}`, { cause: error })
    }
  }
  await measureIntegrationPhase('Installed API dependencies', () => deployProductionApi(deploy, api, {
    dependencies: { root: join(testFixtureCacheRoot(), 'api-dependencies'), source: deployment },
  }))
  await mkdir(join(api, 'test/helpers'), { recursive: true })
  await copyFile(join(repository, 'apps/api/test/helpers/testPool.mjs'), join(api, 'test/helpers/testPool.mjs'))
  const source = join(repository, 'apps/api/src')
  await cp(source, join(api, 'dist'), { recursive: true, filter: path => !path.endsWith('.ts') })
  // Transform the installed modules together without rebuilding a compiler program for each file.
  await build({
    entryPoints: await sources(source),
    outdir: join(api, 'dist'),
    outbase: source,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  })
  await copyApiRuntime(repository, join(api, 'dist'))
  await writeFile(join(api, 'dist/runtime-build.json'),
    `${JSON.stringify(createRuntimeBuildIdentity(repository))}\n`, { mode: 0o600 })
  await cp(join(repository, 'apps/worker/src'), join(release, 'apps/worker/src'), { recursive: true })
  await copyFile(join(repository, 'package.json'), join(release, 'package.json'))
  await copyFile(process.execPath, join(release, 'node'))
  await cp(environment.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY!, join(release, 'worker-artifacts'), { recursive: true })
  await build({
    entryPoints: [fileURLToPath(new URL('../fixtures/remote-review-main.mjs', import.meta.url))],
    outfile: join(api, 'dist/restart-fixture.js'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [{
      name: 'installed-api-imports',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/\.\.\/src\/.*\.ts$/ }, ({ path }) => ({
          path: path.replace('../../src/', './').replace(/\.ts$/, '.js'),
          external: true,
        }))
      },
    }],
  })
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
  const serviceEnvironment = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${serviceUser.uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${serviceUser.uid}/bus` }
  const systemctl = (...args: string[]) => execute('systemctl', ['--user', ...args], {
    env: serviceEnvironment, timeout: 130_000,
  })
  try {
    await publishRestartUnit(unitPath, service)
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
            let diagnostic: string
            try {
              const journal = await execute('journalctl', [
                '--user', '--unit', unit, '--no-pager', '--output=cat', '--lines=40',
              ], { env: serviceEnvironment, timeout: 10_000, maxBuffer: 1024 * 1024 })
              diagnostic = journal.stdout.trim().slice(-16384)
            } catch (journalError) {
              diagnostic = `Could not capture the service journal: ${String(journalError)}`
            }
            throw new Error(`Installed API startup failed: ${unit}\n${diagnostic}`, { cause: error })
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
          await removeRestartUnit(unit)
        }
      },
    }
  } catch (error) {
    try { await removeRestartUnit(unit) }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Restart fixture installation and cleanup failed.', { cause: cleanupError })
    }
    throw error
  }
}
