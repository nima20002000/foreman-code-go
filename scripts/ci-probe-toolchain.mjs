import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

if (!['true', '1'].includes(process.env.CI)) throw new Error('This probe runs only inside Foreman CI.')
const parentPath = join(homedir(), '.cache', 'foreman-capture')
mkdirSync(parentPath, { recursive: true, mode: 0o700 })
const parent = realpathSync(parentPath)
const root = mkdtempSync(join(parent, 'go-probe-'))
const report = value => console.log(`[go-probe] ${JSON.stringify(value)}`)
let bootstrap

async function removeOwnedProbe(directory) {
  if (!existsSync(directory)) return
  const stat = lstatSync(directory)
  report({ cleanupOwnership: { insideProbeParent: directory.startsWith(`${parent}/go-probe-`),
    directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), canonical: realpathSync(directory) === directory,
    sameUser: stat.uid === process.getuid(), mode: (stat.mode & 0o777).toString(8) } })
  if (!directory.startsWith(`${parent}/go-probe-`) || !stat.isDirectory() || stat.isSymbolicLink()
    || realpathSync(directory) !== directory || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Probe cleanup ownership is not confirmed.')
  }
  if (bootstrap && existsSync(join(directory, 'modules'))) {
    const cleanup = await command(bootstrap, ['clean', '-modcache'], {
      PATH: process.env.PATH, HOME: directory, GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local',
      GOMODCACHE: join(directory, 'modules'), GOCACHE: join(directory, 'build'), GOPATH: join(directory, 'gopath'),
    })
    if (cleanup.status !== 0) throw new Error('Official Go cleanup of the owned module cache failed.')
  }
  rmSync(directory, { recursive: true, force: true })
}

async function command(program, args, environment, timeout = 30_000) {
  const child = spawn(program, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16_000) })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16_000) })
  const progress = setInterval(() => report({ status: 'waiting-for-official-toolchain' }), 15_000)
  const deadline = setTimeout(() => child.kill('SIGTERM'), timeout)
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    return { status, stdout: stdout.trim(), stderr: stderr.trim() }
  } finally { clearInterval(progress); clearTimeout(deadline) }
}

try {
  const environment = { PATH: process.env.PATH, HOME: root, CI: 'true', GOENV: 'off', GOWORK: 'off',
    GOTOOLCHAIN: 'local', GOCACHE: join(root, 'build'), GOMODCACHE: join(root, 'modules'),
    GOPATH: join(root, 'gopath'), GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org' }
  const candidates = [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(Boolean)
    .map(directory => join(directory, 'go')), '/usr/local/go/bin/go', '/usr/bin/go'])]
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK) }
    catch { continue /* ignore: an absent standard Go location is an ordinary probe result. */ }
    const version = await command(path, ['version'], environment)
    const match = /^go version go1\.(\d+)(?:\.\d+)?\s/.exec(version.stdout)
    report({ existingBinary: path, status: version.status, version: match ? version.stdout : 'unrecognized version output' })
    if (version.status === 0 && match && Number(match[1]) >= 21) { bootstrap = path; break }
  }
  if (!bootstrap) {
    report({ feasible: false, reason: 'No existing Go >=1.21 found on PATH or standard installed locations.' })
  } else {
    // This task's completed probes left only their invocation roots. The current
    // invocation remains live, and schema captures use a different directory prefix.
    for (const name of readdirSync(parent).filter(name => /^go-probe-[A-Za-z0-9]+$/.test(name))) {
      const previous = join(parent, name)
      if (previous !== root) await removeOwnedProbe(previous)
    }
    report({ previousOwnedProbeCache: 'removed with official go clean -modcache' })
    if (process.argv[2] === '--cleanup-only') {
      report({ cleanupOnly: true, officialToolchainResult: 'retained from verified first probe; no duplicate download' })
    } else {
    report({ requested: 'go1.27.2', proxy: environment.GOPROXY, checksumDatabase: environment.GOSUMDB,
      cache: 'fresh private invocation cache; no existing cache or global Go configuration modified' })
    const result = await command(bootstrap, ['version'], { ...environment, GOTOOLCHAIN: 'go1.27.2' }, 180_000)
    const verified = result.status === 0 && result.stdout === `go version go1.27.2 linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
    const module = `v0.0.1-go1.27.2.linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
    let verifiedModuleChecksum
    if (verified) verifiedModuleChecksum = readFileSync(join(root, 'modules/cache/download/golang.org/toolchain/@v', `${module}.ziphash`), 'utf8').trim()
    const diagnostics = result.stderr.split('\n').filter(line => /go1\.27\.2|golang\.org\/toolchain|proxy\.golang\.org|sum\.golang\.org|404|403|checksum|verification/.test(line)).slice(-8)
    report({ feasible: verified, status: result.status, version: verified ? result.stdout : undefined,
      verifiedModuleChecksum, diagnostics })
    }
  }
} finally { await removeOwnedProbe(root) }
