import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const version = 'go1.27.2'
const moduleVersion = 'v0.0.1-go1.27.2.linux-amd64'
const moduleH1 = 'h1:N6Xv/1OLzI0jVVkUwkrxHRZc/GCTARUo6idcngKwlDE='
const sourceUrl = `https://proxy.golang.org/golang.org/toolchain/@v/${moduleVersion}.zip`
const parent = join(await realpath(homedir()), '.cache', 'foreman-go-zip')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'z-'))
const env = {
  PATH: '/usr/bin:/bin', HOME: root, GOENV: 'off', GOWORK: 'off',
  GOPATH: join(root, 'gopath'), GOCACHE: join(root, 'build'), GOMODCACHE: join(root, 'modules'),
  GOTOOLCHAIN: version, GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
}

function record(value) {
  console.log('[go-zip] ' + JSON.stringify(value))
}

async function go(args, toolchain = version) {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn('/usr/bin/go', args, { env: { ...env, GOTOOLCHAIN: toolchain }, cwd: root })
    const progress = setInterval(() => record({ stage: 'sdk-running', command: args[0] }), 15000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', () => { /* SDK output can contain local paths; report status only. */ })
    child.once('error', error => { clearInterval(progress); reject(error) })
    child.once('close', code => { clearInterval(progress); resolve({ code, output: output.trim() }) })
  })
}

let failed = false
try {
  const bootstrap = await go(['version'], 'local')
  if (bootstrap.code !== 0 || !/^go version go1\.(2[1-9]|[3-9]\d)\./.test(bootstrap.output)) {
    throw new Error('Installed bootstrap Go >=1.21 is required')
  }
  record({ stage: 'bootstrap', version: bootstrap.output, inheritedGorootCleared: true })
  const selected = await go(['version'])
  if (selected.code !== 0 || selected.output !== 'go version go1.27.2 linux/amd64') {
    throw new Error('SDK did not return the pinned Go version')
  }
  const zip = join(env.GOMODCACHE, 'cache/download/golang.org/toolchain/@v', moduleVersion + '.zip')
  const h1 = (await readFile(zip + 'hash', 'utf8')).trim()
  if (h1 !== moduleH1) throw new Error('SDK-verified toolchain module h1 does not match the pinned value')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(zip)) hash.update(chunk)
  record({ stage: 'verified-sdk-module-zip', version, moduleVersion, moduleH1: h1, sourceUrl,
    zipBytes: (await stat(zip)).size, zipSha256: hash.digest('hex'), sdkVersion: selected.output,
    sourceBaseline: '65194efa709d581b84d57de8309a16c7cc0a6e7c', sumdb: env.GOSUMDB })
} catch (error) {
  failed = true
  record({ stage: 'failed', message: error.message })
} finally {
  const cleaned = await go(['clean', '-modcache'], 'local')
  if (cleaned.code !== 0) {
    failed = true
    record({ stage: 'cleanup-failed', exitCode: cleaned.code })
  } else {
    await rm(root, { recursive: true, force: true })
    record({ stage: 'cleanup', ownedCacheRemoved: true })
  }
}
process.exitCode = failed ? 1 : 0
