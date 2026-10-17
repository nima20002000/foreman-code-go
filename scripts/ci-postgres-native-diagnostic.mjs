import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir } from 'node:os'
import { basename, join } from 'node:path'

const source = '7eb4939ea753a8b7479fba1c761a93e387fc82fb'
const checkout = process.cwd()
const pins = JSON.parse(await readFile('scripts/ci-postgres-versions.json', 'utf8'))
const parent = join(await realpath(homedir()), '.cache', 'foreman-pg-diagnostics')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'p-'))
const proxy = join(root, 'commands')
const events = join(root, 'events.jsonl')
const record = value => console.log('[native-postgres] ' + JSON.stringify(value))
const clean = text => text.replaceAll(root, '<owned-cache>').replaceAll(checkout, '<checkout>')
const facts = { source,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uid: process.getuid(), commands: [], compilerInvocations: [], configFeatures: [],
  diagnostics: [], pins, cleanup: false }
const env = { PATH: proxy + ':' + process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
  LANG: 'C.UTF-8', LC_ALL: 'C', FOREMAN_CODE_CI_POSTGRES_CACHE: join(root, 'cache'),
  FOREMAN_CODE_CI_CPU_COUNT: String(Math.min(2, Math.max(1, Number(process.env.FOREMAN_CODE_CI_CPU_COUNT) || availableParallelism()))),
  FOREMAN_PG_PROXY_STATE: join(root, 'proxy.json') }
let sourceName = 'initialization'
let lastOutputAt = new Date().toISOString()
let failed = false

async function run(name, program, args, input) {
  const startedAt = new Date().toISOString()
  record({ stage: 'command-start', name })
  let stdout = ''
  let stderr = ''
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, cwd: checkout, stdio: ['pipe', 'pipe', 'pipe'] })
    const consume = (chunk, channel) => {
      const text = chunk.toString()
      lastOutputAt = new Date().toISOString()
      if (channel === 'stdout') stdout += text
      else stderr += text
      for (const line of text.split('\n')) {
        const tool = /Preparing cached PostgreSQL build tool: (\w+)/.exec(line)
        if (tool) sourceName = tool[1]
        if (/\b(?:cc|gcc|g\+\+|c\+\+)\b.*\s(?:-c|-o)\s/.test(line)
          && facts.compilerInvocations.length < 30) facts.compilerInvocations.push({ source: sourceName, line: clean(line) })
        if (/error:|Error [0-9]|failed|Could not|All pinned|SHA-256 mismatch|patching file/i.test(line)) {
          facts.diagnostics.push(clean(line).slice(0, 1200))
          if (facts.diagnostics.length > 100) facts.diagnostics.shift()
        }
      }
    }
    child.stdout.on('data', chunk => consume(chunk, 'stdout'))
    child.stderr.on('data', chunk => consume(chunk, 'stderr'))
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
    child.stdin.end(input)
  })
  const output = stdout + stderr
  const result = { name, exitCode, startedAt, finishedAt: new Date().toISOString(),
    outputBytes: Buffer.byteLength(output), outputSha256: createHash('sha256').update(output).digest('hex') }
  facts.commands.push(result)
  record({ stage: 'command-finish', ...result })
  return { exitCode, stdout, stderr }
}

async function observeConfiguration() {
  let entries
  try { entries = await readdir(env.FOREMAN_CODE_CI_POSTGRES_CACHE) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const entry of entries.filter(name => /^install\.[a-zA-Z0-9]+$/.test(name))) {
    let content
    try { content = await readFile(join(env.FOREMAN_CODE_CI_POSTGRES_CACHE, entry, 'm4-build/config.log'), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const lines = content.split('\n').filter(line =>
      /checking.*(?:memchr|wmemchr|bsearch|strchr|C23)|^ac_cv_.*(?:memchr|wmemchr|bsearch|strchr)|^(?:CC|CFLAGS|CPPFLAGS)=/.test(line))
    facts.configFeatures = [...new Set([...facts.configFeatures, ...lines.map(clean)])].slice(-80)
  }
}

let observing = false
const watcher = setInterval(() => {
  if (observing) return
  observing = true
  observeConfiguration().catch(error => { failed = true; record({ stage: 'configuration-observation-error', code: error.code }) })
    .finally(() => { observing = false })
}, 500)
const progress = setInterval(() => record({ stage: 'running', source: sourceName, lastOutputAt,
  compilerCommands: facts.compilerInvocations.length, configFeatures: facts.configFeatures.length }), 15000)

try {
  if (facts.uid === 0) throw new Error('An existing unprivileged CI user is required')
  await Promise.all([proxy, env.HOME, env.TMPDIR].map(path => mkdir(path, { mode: 0o700 })))
  const programs = {}
  for (const name of ['curl', 'patch']) {
    programs[name] = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' }).trim()
    if (!programs[name].startsWith('/')) throw new Error('Existing ' + name + ' is required')
  }
  await writeFile(events, '')
  await writeFile(env.FOREMAN_PG_PROXY_STATE, JSON.stringify({ programs, events }))
  const proxyProgram = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { basename } = require('node:path');
const state=JSON.parse(readFileSync(process.env.FOREMAN_PG_PROXY_STATE,'utf8'));
const name=basename(process.argv[1]);
const args=process.argv.slice(2);
const entry={program:name,startedAt:new Date().toISOString()};
if(name==='curl')entry.url=args.at(-1);
if(name==='patch'){const file=args[args.indexOf('--input')+1];entry.patch=basename(file);entry.sha256=createHash('sha256').update(readFileSync(file)).digest('hex');}
const child=spawn(state.programs[name],args,{stdio:'inherit'});
child.once('error',error=>{appendFileSync(state.events,JSON.stringify({...entry,errorCode:error.code})+'\\n');process.exitCode=1;});
child.once('close',code=>{appendFileSync(state.events,JSON.stringify({...entry,exitCode:code,finishedAt:new Date().toISOString()})+'\\n');process.exitCode=code??1;});
`
  for (const name of ['curl', 'patch']) {
    const file = join(proxy, name)
    await writeFile(file, proxyProgram)
    await chmod(file, 0o700)
  }
  record({ stage: 'provenance', source, checkoutSha: facts.checkoutSha, uid: facts.uid,
    databaseStarted: false, cpuCount: Number(env.FOREMAN_CODE_CI_CPU_COUNT) })
  facts.compiler = clean((await run('compiler-version', 'cc', ['--version'])).stdout.trim())
  facts.libc = (await run('libc-version', 'getconf', ['GNU_LIBC_VERSION'])).stdout.trim()
  const key = await run('cache-key', 'bash', ['scripts/ci-postgres-toolchain.sh', 'cache-key'])
  if (key.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(key.stdout.trim())) throw new Error('Installer cache-key failed')
  const installed = await run('install', 'bash', ['scripts/ci-postgres-toolchain.sh', 'install'])
  if (installed.exitCode !== 0) throw new Error('Installer failed; original command exit status retained')
  const verified = await run('verify', 'bash', ['scripts/ci-postgres-toolchain.sh', 'verify'])
  if (verified.exitCode !== 0) throw new Error('Public PostgreSQL verification failed')
  const toolchain = join(env.FOREMAN_CODE_CI_POSTGRES_CACHE, 'toolchains', 'postgresql-' + pins.postgresql.version + '-' + key.stdout.trim())
  facts.versions = {}
  for (const name of ['initdb', 'postgres', 'pg_isready', 'psql', 'createdb', 'pg_ctl', 'pg_config', 'pg_dump', 'pg_restore']) {
    const result = await run('version-' + name, join(toolchain, 'bin', name), ['--version'])
    if (result.exitCode !== 0) throw new Error('Verified PostgreSQL tool failed: ' + name)
    facts.versions[name] = result.stdout.trim()
  }
  const m4 = join(toolchain, 'parser-tools/bin/m4')
  facts.m4Version = (await run('m4-version', m4, ['--version'])).stdout.split('\n')[0]
  const macro = await run('m4-macro', m4, [], "define(`OWNED_CHECK',`compatibility-ok')OWNED_CHECK\n")
  facts.m4Macro = macro.stdout.trim()
  if (macro.exitCode !== 0 || facts.m4Macro !== 'compatibility-ok') throw new Error('Installed m4 macro behavior failed')
} catch (error) {
  failed = true
  facts.failure = clean(error.message)
} finally {
  clearInterval(watcher)
  clearInterval(progress)
  while (observing) await new Promise(resolve => setTimeout(resolve, 25))
  try { facts.transfersAndPatches = (await readFile(events, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await rm(root, { recursive: true, force: true })
  facts.cleanup = true
  facts.failed = failed
  record({ stage: 'result', ...facts })
}
process.exitCode = failed ? 1 : 0
