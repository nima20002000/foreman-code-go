import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { renderUserService } from '../apps/worker/src/service.mjs'
import { workerPath } from '../apps/worker/src/harnessPath.mjs'
import { buildWorkerReleaseArtifacts, publishWorkerArtifactsToGitHub } from './worker-release-artifacts.mjs'
import {
  copyVerificationRuntime, deployProductionApi, desktopLaunchEnvironment, localProductionEnvironment, preserveOperatorConfiguration, publish, readEnvironment,
  pruneReleases, removeUninstalledRelease, readActiveRuns, readProductionIdentity, waitForIdleRuns, renderEnvironment, waitForProductionReady, withInstallationLock,
  shouldOpenDashboardAfterInstall,
  productionIntegrationPaths, publishDesktopIntegration, enableProductionServices, launchProduction, launchBrowser,
} from './local-production-runtime.mjs'

const source = fileURLToPath(new URL('../', import.meta.url))
const home = homedir()
const app = join(home, '.local/lib/graphql-production')
const state = join(home, '.local/state/graphql-production')
const data = join(home, '.local/share/graphql-production')
const config = join(home, '.config/graphql-production')
const envFile = join(config, 'production.env')
const current = join(app, 'current')
const origin = 'http://127.0.0.1:3041'
const capture = promisify(execFile)
const units = {
  database: 'graphql-production-db.service',
  api: 'graphql-operator-api.service',
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: source, stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ?? code}).`))
    })
  })
}

async function configureEnvironment() {
  for (const directory of [config, state, data, app, join(data, 'files'), join(data, 'workspaces'),
    join(state, 'runs'), join(state, 'logs'), join(state, 'cache')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  let password
  const previous = await readEnvironment(envFile)
  if (previous) {
    password = readProductEnvironment(previous, 'PRODUCTION_DB_PASSWORD')
    if (!password || !/^[a-f0-9]{64}$/.test(password)) {
      throw new Error('The production database password is missing or invalid. Restore production.env; do not reset the database.')
    }
  } else {
    const { stdout } = await capture('/usr/bin/docker', ['volume', 'ls', '--format', '{{.Name}}'])
    if (stdout.split('\n').includes('graphql-production-postgres')) {
      throw new Error('Production storage already exists. Restore production.env before updating; its password must stay stable.')
    }
    password = randomBytes(32).toString('hex')
  }
  const owned = localProductionEnvironment(home, password)
  const { loadConfig } = await import('../apps/api/dist/config.js')
  const environment = await preserveOperatorConfiguration(join(config, 'operator.json'), previous, owned, loadConfig)
  await publish(envFile, renderEnvironment(environment))
  return environment
}

async function stageRelease() {
  const releases = join(app, 'releases')
  await mkdir(releases, { recursive: true, mode: 0o700 })
  const release = await mkdtemp(join(releases, 'release-'))
  try {
    await mkdir(join(release, 'apps'), { recursive: true })
    await deployProductionApi(run, join(release, 'apps/api'))
    await cp(join(source, 'apps/web/dist'), join(release, 'apps/web/dist'), { recursive: true })
    await mkdir(join(release, 'scripts'), { recursive: true })
    for (const name of ['local-production.mjs', 'local-production-runtime.mjs', 'graphql-mcp.mjs',
      'worker-release-artifacts.mjs', 'worker-artifact-files.mjs']) {
      await copyFile(join(source, 'scripts', name), join(release, 'scripts', name))
    }
    await copyVerificationRuntime(source, release)
    const contractsSource = join(release, 'packages/contracts/src')
    await mkdir(contractsSource, { recursive: true })
    await copyFile(join(source, 'packages/contracts/src/productEnvironment.mjs'),
      join(contractsSource, 'productEnvironment.mjs'))
    await mkdir(join(release, 'apps/worker/src'), { recursive: true })
    for (const name of ['service.mjs', 'diagnostics.mjs', 'harnessPath.mjs']) {
      await copyFile(join(source, 'apps/worker/src', name), join(release, 'apps/worker/src', name))
    }
    await copyFile(process.execPath, join(release, 'node'))
    await chmod(join(release, 'node'), 0o700)
    await buildWorkerReleaseArtifacts({ repository: source, directory: join(release, 'worker-artifacts'),
      productManifestPath: join(release, 'package.json'), run, publish: publishWorkerArtifactsToGitHub })
    return release
  } catch (error) {
    await removeUninstalledRelease(release, current)
    throw error
  }
}

function service(template) {
  return renderUserService(template, {
    node: join(current, 'node'), app, state, home,
    path: `${current}:${workerPath(home, process.execPath)}`,
  })
}

async function installServices() {
  const directory = productionIntegrationPaths(home, process.env).units
  await publish(join(directory, units.database), service(`[Unit]
Description=Foreman Code production PostgreSQL
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=@HOME@/.config/graphql-production/production.env
ExecStartPre=/usr/bin/timeout 60 /bin/sh -c 'until /usr/bin/docker info >/dev/null 2>&1; do /usr/bin/sleep 2; done'
ExecStart=/usr/bin/docker compose --project-name graphql-local-production --file @APP@/compose.production.yaml up --detach --wait --wait-timeout 90 postgres
ExecStop=/usr/bin/docker compose --project-name graphql-local-production --file @APP@/compose.production.yaml stop --timeout 30 postgres
Restart=on-failure
RestartSec=5
TimeoutStartSec=160
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=default.target
`))
  await publish(join(directory, units.api), service(`[Unit]
Description=Foreman Code production API and dashboard
Wants=${units.database}
After=${units.database}
StartLimitIntervalSec=0

[Service]
Type=exec
Delegate=yes
WorkingDirectory=@APP@/current/apps/api
EnvironmentFile=@HOME@/.config/graphql-production/production.env
Environment=FOREMAN_CODE_API_ENV_FILE=@HOME@/.config/graphql-production/production.env
Environment=FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY=@APP@/current/worker-artifacts
Environment=PATH=@PATH@
ExecStart=@NODE@ @APP@/current/apps/api/dist/server.js
ExecStartPost=@NODE@ @APP@/current/scripts/local-production.mjs health
Restart=always
RestartSec=3
TimeoutStartSec=120
TimeoutStopSec=60
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
`))
}

async function installDesktop(firstInstall) {
  const paths = productionIntegrationPaths(home, process.env)
  const icon = paths.icon
  const launcher = join(app, 'graphql')
  await publish(launcher, `#!/bin/sh
exec '${current}/node' '${current}/scripts/local-production.mjs' launch
`, 0o700)
  await publishDesktopIntegration(paths, { firstInstall,
    icon: await readFile(join(source, 'apps/web/public/graphql.svg')),
    desktop: `[Desktop Entry]
Type=Application
Name=Foreman Code
Comment=Local agent workspace
Exec=${launcher}
Icon=${icon}
StartupWMClass=graphql-production
Terminal=true
Categories=Development;
`, autostart: `[Desktop Entry]
Type=Application
Name=Foreman Code
Comment=Start the local dashboard after desktop login
Exec=${launcher}
Icon=${icon}
Terminal=true
X-GNOME-Autostart-enabled=true
` })
}

async function waitForReady(timeoutMs = 90_000) {
  const environment = await readEnvironment(envFile)
  if (!environment) throw new Error('Production configuration is missing.')
  const release = await realpath(current)
  const expected = await readProductionIdentity(release, environment.DATABASE_URL)
  await waitForProductionReady({ origin, expected, timeoutMs })
}

async function install() {
  // The worker service renderer also validates the installation paths before any mutation.
  service('@NODE@ @APP@ @STATE@ @HOME@ @PATH@')
  await access('/usr/bin/docker', constants.X_OK)
  await access('/usr/bin/google-chrome', constants.X_OK)
  await access('/usr/bin/ss', constants.X_OK)
  let previousRelease
  try {
    previousRelease = await realpath(current)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const firstInstall = !previousRelease && !(await readEnvironment(envFile))
  await run('corepack', ['pnpm', 'install', '--frozen-lockfile'])
  await run('corepack', ['pnpm', 'build'])
  const environment = await configureEnvironment()
  const release = await stageRelease()
  try {
    if (previousRelease) {
      await readActiveRuns(release, environment.DATABASE_URL, (query) => waitForIdleRuns({ query,
        timeoutMs: Number(process.env.FOREMAN_INSTALL_RUN_WAIT_MINUTES ?? 120) * 60_000,
        interrupt: process.env.FOREMAN_INSTALL_INTERRUPT_RUNS === '1' }))
    }
    await copyFile(join(source, 'compose.production.yaml'), join(app, 'compose.production.yaml'))
    await run('/usr/bin/docker', ['volume', 'create', '--label', 'io.graphql.environment=production', 'graphql-production-postgres'])
    await installServices()
    await installDesktop(firstInstall)
    await run('/usr/bin/systemctl', ['--user', 'daemon-reload'])
    await run('/usr/bin/systemctl', ['--user', 'start', units.database])
    await run('/usr/bin/systemctl', ['--user', 'stop', units.api])
    await run(join(release, 'node'), ['dist/cli/migrate.js'], {
      cwd: join(release, 'apps/api'), env: { ...process.env, ...environment },
    })
    const upgradeModule = join(release, 'apps/api/dist/modules/harnesses/productionMcpUpgrade.js')
    const { upgradeProductionMcpLauncher } = await import(pathToFileURL(upgradeModule))
    await upgradeProductionMcpLauncher(home)
    const pending = join(app, `current.${randomBytes(8).toString('hex')}`)
    try {
      await symlink(release, pending)
      await rename(pending, current)
    } finally {
      await rm(pending, { force: true })
    }
    await enableProductionServices(run, [units.database, units.api], { firstInstall })
    await run('/usr/bin/systemctl', ['--user', 'start', units.api])
    await waitForReady()
    const pruned = await pruneReleases(join(app, 'releases'), [release, previousRelease])
    if (pruned.length) console.log(`Removed ${pruned.length} old release(s); kept the current and previous release.`)
    console.log(`Foreman Code backend installed: ${origin}/workspaces`)
    if (shouldOpenDashboardAfterInstall({ previousRelease, stdin: process.stdin, stdout: process.stdout })) {
      await handoffDashboard()
    } else {
      console.log('Open Foreman Code from the desktop launcher when ready.')
    }
    console.log(`API logs: ${state}/logs (and journalctl --user -u ${units.api})`)
  } finally {
    await removeUninstalledRelease(release, current)
  }
}

async function handoffDashboard() {
  await launchBrowser('/usr/bin/google-chrome', [`--app=${origin}/workspaces`, '--class=graphql-production'], {
    environment: desktopLaunchEnvironment(process.env),
  })
  console.log('Dashboard handed to Chrome.')
}

async function launchDesktop() {
  console.log('Starting Foreman Code; waiting for the local backend…')
  await launchProduction({
    lockPath: join(config, 'install.lock'),
    start: () => capture('/usr/bin/systemctl', ['--user', 'start', '--no-block', units.api], { timeout: 5000 }),
    ready: waitForReady,
    openDashboard: handoffDashboard,
  })
}

const command = process.argv[2]
try {
  if (command === 'install') {
    productionIntegrationPaths(home, process.env)
    await withInstallationLock(join(config, 'install.lock'), install)
  }
  else if (command === 'health') await waitForReady()
  else if (command === 'open' || command === 'launch') await launchDesktop()
  else throw new Error('Usage: node scripts/local-production.mjs install|health|open|launch')
} catch (error) {
  console.error(`Local production setup failed: ${error.message}`)
  if (command === 'open' || command === 'launch') {
    try {
      await capture('/usr/bin/notify-send', ['Foreman Code could not open',
        'Open a terminal and run the Foreman Code launcher for details. Check journalctl --user -u graphql-operator-api.service.'],
      { timeout: 5000 })
    } catch {
      console.error('Desktop notification unavailable; the launch error is shown in this terminal.')
    }
  }
  process.exitCode = 1
}
