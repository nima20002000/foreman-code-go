import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { renderUserService } from '../apps/worker/src/service.mjs'
import { workerPath } from '../apps/worker/src/harnessPath.mjs'
import { preserveOperatorConfiguration, publish, readEnvironment, readProductionIdentity, renderEnvironment,
  waitForProductionReady, withInstallationLock } from './local-production-runtime.mjs'

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
    join(state, 'runs'), join(state, 'mcp'), join(state, 'logs'), join(state, 'cache')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  let password
  const previous = await readEnvironment(envFile)
  if (previous) {
    password = previous.GRAPHQL_PRODUCTION_DB_PASSWORD
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
  const owned = {
    NODE_ENV: 'production',
    GRAPHQL_LOCAL_PRODUCTION: '1',
    HOST: '127.0.0.1',
    PORT: '3041',
    DATABASE_URL: `postgresql://graphql_production:${password}@127.0.0.1:55440/graphql_production`,
    GRAPHQL_PRODUCTION_DB_PASSWORD: password,
    GRAPHQL_BROWSER_ORIGIN: origin,
    GRAPHQL_WEB_DIST: join(current, 'apps/web/dist'),
    WORKSPACE_STORAGE_ROOT: join(data, 'workspaces'),
    FILE_STORAGE_ROOT: join(data, 'files'),
    HARNESS_WORKSPACE_ROOT: join(state, 'runs'),
    GRAPHQL_APP_MCP_DIRECTORY: join(state, 'mcp'),
    LOG_DIR: join(state, 'logs'),
    XDG_CACHE_HOME: join(state, 'cache'),
    LANGGRAPH_CHECKPOINT_SCHEMA: 'langgraph',
    GRAPHQL_DEV_BROWSER_ACCESS: '0',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  }
  const { loadConfig } = await import('../apps/api/dist/config.js')
  const environment = await preserveOperatorConfiguration(join(config, 'operator.json'), previous, owned, loadConfig)
  await publish(envFile, renderEnvironment(environment))
  return environment
}

async function stageRelease() {
  const releases = join(app, 'releases')
  await mkdir(releases, { recursive: true, mode: 0o700 })
  const release = await mkdtemp(join(releases, 'release-'))
  await mkdir(join(release, 'apps'), { recursive: true })
  await run('corepack', ['pnpm', '--filter', '@graphql/api', 'deploy', '--prod', '--legacy', join(release, 'apps/api')])
  await cp(join(source, 'apps/web/dist'), join(release, 'apps/web/dist'), { recursive: true })
  await mkdir(join(release, 'scripts'), { recursive: true })
  for (const name of ['local-production.mjs', 'local-production-runtime.mjs', 'graphql-mcp.mjs']) {
    await copyFile(join(source, 'scripts', name), join(release, 'scripts', name))
  }
  await mkdir(join(release, 'apps/worker/src'), { recursive: true })
  for (const name of ['service.mjs', 'diagnostics.mjs', 'harnessPath.mjs']) {
    await copyFile(join(source, 'apps/worker/src', name), join(release, 'apps/worker/src', name))
  }
  await copyFile(process.execPath, join(release, 'node'))
  await chmod(join(release, 'node'), 0o700)
  return release
}

function service(template) {
  return renderUserService(template, {
    node: join(current, 'node'), app, state, home,
    path: `${current}:${workerPath(home, process.execPath)}`,
  })
}

async function installServices() {
  const directory = join(home, '.config/systemd/user')
  await publish(join(directory, units.database), service(`[Unit]
Description=graphql production PostgreSQL
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=@HOME@/.config/graphql-production/production.env
ExecStartPre=/bin/sh -c 'until /usr/bin/docker info >/dev/null 2>&1; do /usr/bin/sleep 2; done'
ExecStart=/usr/bin/docker compose --project-name graphql-local-production --file @APP@/compose.production.yaml up --detach --wait --wait-timeout 90 postgres
ExecStop=/usr/bin/docker compose --project-name graphql-local-production --file @APP@/compose.production.yaml stop --timeout 30 postgres
Restart=on-failure
RestartSec=5
TimeoutStartSec=0
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=default.target
`))
  await publish(join(directory, units.api), service(`[Unit]
Description=graphql production API and dashboard
Wants=${units.database}
After=${units.database}
StartLimitIntervalSec=0

[Service]
Type=exec
Delegate=yes
WorkingDirectory=@APP@/current/apps/api
EnvironmentFile=@HOME@/.config/graphql-production/production.env
Environment=GRAPHQL_API_ENV_FILE=@HOME@/.config/graphql-production/production.env
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

async function installDesktop() {
  const icon = join(home, '.local/share/icons/hicolor/scalable/apps/graphql-production.svg')
  await publish(icon, await readFile(join(source, 'apps/web/public/graphql.svg')), 0o644)
  const launcher = join(app, 'graphql')
  await publish(launcher, `#!/bin/sh
/usr/bin/systemctl --user start ${units.api} || exit 1
exec '${current}/node' '${current}/scripts/local-production.mjs' open
`, 0o700)
  await publish(join(home, '.local/share/applications/graphql-production.desktop'), `[Desktop Entry]
Type=Application
Name=graphql
Comment=Local agent workspace
Exec=${launcher}
Icon=${icon}
StartupWMClass=graphql-production
Terminal=false
Categories=Development;
`, 0o644)
  await publish(join(home, '.config/autostart/graphql-production.desktop'), `[Desktop Entry]
Type=Application
Name=graphql
Comment=Start the local dashboard after desktop login
Exec=${launcher}
Icon=${icon}
Terminal=false
X-GNOME-Autostart-enabled=true
`, 0o644)
}

async function waitForReady() {
  const environment = await readEnvironment(envFile)
  if (!environment) throw new Error('Production configuration is missing.')
  const release = await realpath(current)
  const expected = await readProductionIdentity(release, environment.DATABASE_URL)
  await waitForProductionReady({ origin, expected })
}

async function install() {
  // The worker service renderer also validates the installation paths before any mutation.
  service('@NODE@ @APP@ @STATE@ @HOME@ @PATH@')
  await access('/usr/bin/docker', constants.X_OK)
  await access('/usr/bin/google-chrome', constants.X_OK)
  await run('corepack', ['pnpm', 'install', '--frozen-lockfile'])
  await run('corepack', ['pnpm', 'build'])
  const environment = await configureEnvironment()
  const release = await stageRelease()
  await copyFile(join(source, 'compose.production.yaml'), join(app, 'compose.production.yaml'))
  await run('/usr/bin/docker', ['volume', 'create', '--label', 'io.graphql.environment=production', 'graphql-production-postgres'])
  await installServices()
  await installDesktop()
  await run('/usr/bin/systemctl', ['--user', 'daemon-reload'])
  await run('/usr/bin/systemctl', ['--user', 'start', units.database])
  await run('/usr/bin/systemctl', ['--user', 'stop', units.api])
  await run(join(release, 'node'), ['dist/cli/migrate.js'], {
    cwd: join(release, 'apps/api'), env: { ...process.env, ...environment },
  })
  const pending = join(app, `current.${randomBytes(8).toString('hex')}`)
  try {
    await symlink(release, pending)
    await rename(pending, current)
  } finally {
    await rm(pending, { force: true })
  }
  await run('/usr/bin/systemctl', ['--user', 'enable', units.database, units.api])
  await run('/usr/bin/systemctl', ['--user', 'start', units.api])
  await openDashboard()
  console.log(`graphql installed: ${origin}/workspaces`)
  console.log(`API logs: ${state}/logs (and journalctl --user -u ${units.api})`)
}

async function openDashboard() {
  await waitForReady()
  // Chrome joins the owner's browser session; closing the launcher must not close their browser.
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/google-chrome', [`--app=${origin}/workspaces`, '--class=graphql-production'], {
      detached: true, stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

const command = process.argv[2]
try {
  if (command === 'install') await withInstallationLock(join(config, 'install.lock'), install)
  else if (command === 'health') await waitForReady()
  else if (command === 'open') await openDashboard()
  else throw new Error('Usage: node scripts/local-production.mjs install|health|open')
} catch (error) {
  console.error(`Local production setup failed: ${error.message}`)
  process.exitCode = 1
}
