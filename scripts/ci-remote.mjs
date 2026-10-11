// Runs a test command through Main's CI instead of on this computer:
//   node scripts/ci-remote.mjs <suite> -- <local command...>
// On a CI machine (CI=true: cloud runners and build computers) or with FOREMAN_CODE_CI_LOCAL=1 it runs the local
// command. Anywhere else it snapshots the working tree (uncommitted changes included) as a commit, pushes it to
// GitHub, starts Main's ci_run for it, streams progress and failures, and exits with the run's result.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { affectedSnapshot } from './ci-affected.mjs'

const environment = process.env

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

/** The working tree as a commit on HEAD, without touching the index, branch or files. */
export function snapshot(cwd = process.cwd()) {
  const directory = mkdtempSync(join(environment.TMPDIR ?? tmpdir(), 'ci-index-'))
  try {
    const env = { ...environment, GIT_INDEX_FILE: join(directory, 'index') }
    git(['read-tree', 'HEAD'], { env, cwd })
    git(['add', '-A'], { env, cwd })
    const tree = git(['write-tree'], { env, cwd })
    if (tree === git(['rev-parse', 'HEAD^{tree}'], { cwd })) return git(['rev-parse', 'HEAD'], { cwd })
    // A throwaway commit only CI reads, so it needs no personal identity.
    const identity = { GIT_AUTHOR_NAME: 'Foreman Code CI', GIT_AUTHOR_EMAIL: 'ci@foreman-code.invalid',
      GIT_COMMITTER_NAME: 'Foreman Code CI', GIT_COMMITTER_EMAIL: 'ci@foreman-code.invalid' }
    return git(['commit-tree', tree, '-p', 'HEAD', '-m', 'CI snapshot of uncommitted changes'], { cwd, env: { ...environment, ...identity } })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

async function mcpClient() {
  const base = environment.FOREMAN_CODE_MAIN_URL ?? 'http://127.0.0.1:3041'
  const tokenFile = environment.FOREMAN_CODE_OPERATOR_TOKEN_FILE
    ?? join(homedir(), '.local/share/foreman-code/production-operator.private.json')
  const token = environment.FOREMAN_CODE_OPERATOR_TOKEN ?? JSON.parse(readFileSync(tokenFile, 'utf8')).token
  let session, version
  const request = async (method, params) => {
    const id = randomUUID()
    const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(300_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}), ...(version ? { 'Mcp-Protocol-Version': version } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    session = response.headers.get('mcp-session-id') ?? session
    const body = await response.text()
    const envelope = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body)
      : body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(value => value.id === id)
    if (!envelope || envelope.error) throw new Error(`Main refused ${method}: ${JSON.stringify(envelope?.error ?? body).slice(0, 400)}`)
    return envelope.result
  }
  version = (await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'ci-remote', version: '1' } })).protocolVersion
  return async (name, args) => {
    const result = await request('tools/call', { name, arguments: args })
    const text = result.content?.[0]?.text ?? ''
    let value
    try { value = text ? JSON.parse(text) : result.structuredContent } catch { throw new Error(`${name}: ${text.slice(0, 400)}`) }
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(value).slice(0, 600)}`)
    return value?.value ?? value
  }
}

/** A suite part by its name (typecheck-api), an integration partition by its number. */
const partName = run => run.part ?? (run.partition ? `part ${run.partition.index + 1} of ${run.partition.count}` : run.suite)

/** Pushes the snapshot for Main's CI. Several commands often push the same commit at once (an agent running test
 * and lint together); GitHub refuses all but one ref update, and the branch then already holds the commit. */
async function publish(commit) {
  const ref = `refs/heads/foreman/ci/${commit}`
  for (let attempt = 1; ; attempt++) {
    try { git(['push', '--quiet', 'origin', `${commit}:${ref}`]); return } catch (error) {
      const published = (() => { try { return git(['ls-remote', 'origin', ref]).split(/\s/)[0] } catch { return '' } })()
      if (published === commit) return
      if (attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
    }
  }
}

async function remote(suite, args) {
  if (args.length) console.error('[ci] Selecting affected files from the snapshot; command arguments apply to local runs only.')
  const call = await mcpClient()
  const origin = git(['remote', 'get-url', 'origin']).replace(/\.git$/, '')
  const repository = /github\.com[:/]([^/]+\/[^/]+)$/.exec(origin)?.[1]
  if (!repository) throw new Error(`The origin remote is not a GitHub repository: ${origin}`)
  // The list omits repository details; read each workspace until one uses this repository.
  let workspaceId = environment.FOREMAN_CODE_WORKSPACE_ID
  for (const item of workspaceId ? [] : (await call('workspace_list', {})).items ?? []) {
    const value = (await call('workspace_get', { workspaceId: item.workspace.id })).workspace?.repository
    if (value && `${value.owner}/${value.name}`.toLowerCase() === repository.toLowerCase()) { workspaceId = item.workspace.id; break }
  }
  if (!workspaceId) throw new Error(`No Foreman Code workspace uses ${repository}.`)
  const commit = snapshot()
  const selection = environment.FOREMAN_CODE_CI_SCOPE === 'full' || git(['branch', '--show-current']) === 'main'
    ? { scope: 'full', files: [], reason: 'Full scope requested.' } : affectedSnapshot(commit, suite)
  if (selection.files.length > 2000) {
    selection.scope = 'full'
    selection.files = []
    selection.reason = 'Selection exceeds the CI request limit.'
  }
  console.error(`[ci] ${selection.scope}: ${selection.reason} ${selection.files.length} selected files.`)
  await publish(commit)
  const partitions = suite === 'integration' ? Number(environment.FOREMAN_CODE_CI_PARTITIONS ?? 32) : undefined
  const started = await call('ci_run', { workspaceId, suite, commit, scope: selection.scope,
    ...(selection.scope === 'affected' ? { files: selection.files } : {}),
    commandId: randomUUID(), ...(partitions ? { partitions } : {}) })
  const tickets = (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId)
  console.error(`[ci] ${suite} of ${commit.slice(0, 12)} on ${tickets.length} CI ${tickets.length === 1 ? 'machine' : 'machines'}`)
  const startedAt = Date.now(), states = new Map()
  for (;;) {
    // A few reads at a time keep Main's database pool free for the runs themselves.
    const runs = []
    for (let index = 0; index < tickets.length; index += 4) {
      runs.push(...await Promise.all(tickets.slice(index, index + 4)
        .map(ticketId => call('ci_get', { workspaceId, ticketId }).then(value => value.run))))
    }
    for (const run of runs) {
      const line = `${run.state}${run.computer ? ` on ${run.computer.label}` : ''}`
      if (states.get(run.id) !== line) { states.set(run.id, line); console.error(`[ci] ${Math.round((Date.now() - startedAt) / 1000)}s ${partName(run)}: ${line}`) }
    }
    if (runs.every(run => !['queued', 'starting', 'running'].includes(run.state))) {
      const failed = runs.filter(run => run.state !== 'passed')
      for (const run of failed) {
        const log = await call('ci_logs_read', { workspaceId, ticketId: run.id, maxBytes: 65_536 }).catch(() => ({ text: '' }))
        const lines = log.text.split('\n').filter(line => /FAIL|failed files|hung files|error TS|  error  |Error:|×|AssertionError/.test(line))
        console.log(`\n[ci] ${partName(run)} ${run.state}${run.message ? `: ${run.message}` : ''}`)
        console.log(lines.slice(-60).join('\n') || log.text.slice(-4000))
      }
      console.error(`[ci] ${suite} ${failed.length ? 'FAILED' : 'passed'} in ${Math.round((Date.now() - startedAt) / 1000)}s`)
      return failed.length ? 1 : 0
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [suite, separator, ...command] = process.argv.slice(2)
  if (!suite || separator !== '--' || !command.length) {
    console.error('usage: node scripts/ci-remote.mjs <suite> -- <local command...>')
    process.exit(2)
  }
  if (environment.CI === 'true' || environment.FOREMAN_CODE_CI_LOCAL === '1') {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
  } else {
    process.exitCode = await remote(suite, command.slice(1)).catch(error => {
      console.error(`[ci] ${error.message}`)
      console.error('[ci] Tests run on the CI computers through Main. Check that Main is running and reachable '
        + '(FOREMAN_CODE_MAIN_URL) with an Operator credential (FOREMAN_CODE_OPERATOR_TOKEN_FILE), '
        + 'or run on this computer on purpose with FOREMAN_CODE_CI_LOCAL=1.')
      return 1
    })
  }
}
