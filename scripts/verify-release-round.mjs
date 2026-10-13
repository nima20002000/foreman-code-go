// Checks that a release commit ships only code that passed one clean full round through Foreman CI:
//   node scripts/verify-release-round.mjs <release commit>
// The deploy watcher must call this before it deploys a 'Release vX.Y.Z' commit and skip the release when it exits
// non-zero. A release commit (written by scripts/release.mjs) changes only the version in package.json and
// CHANGELOG.md on top of its parent, and records the round in 'Clean-Round: gate=<ticket ids>' (one gate group covering
// typecheck, lint, unit and integration) or older 'Clean-Round: <suite>=<ticket ids>' trailers. Every recorded group
// must have run on the parent commit with full scope, and every part must have passed.
// Main is reached like scripts/ci-remote.mjs: FOREMAN_CODE_MAIN_URL, FOREMAN_CODE_OPERATOR_TOKEN(_FILE) and
// optionally FOREMAN_CODE_WORKSPACE_ID.
import { execFileSync } from 'node:child_process'
import { mcpClient, workspaceFor } from './ci-remote.mjs'

export const RELEASE_SUITES = ['typecheck', 'lint', 'unit', 'integration']

/** The one commandId for gating a commit, shared by releases and the gate line so a passed gate is reused. */
export const gateCommandId = commit => `gate-${commit}`

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Problems that keep the release commit from deploying; empty when its clean round is verified. */
export async function releaseRoundProblems(call, workspaceId, commit, cwd = process.cwd()) {
  const parent = git(['rev-parse', `${commit}^`], cwd)
  const problems = []
  const changed = git(['diff', '--name-only', parent, commit], cwd).split('\n').filter(Boolean)
  const extra = changed.filter(file => file !== 'package.json' && file !== 'CHANGELOG.md')
  if (extra.length) problems.push(`The release commit changes code beyond the version and changelog: ${extra.join(', ')}`)
  if (changed.includes('package.json')) {
    const manifest = revision => ({ ...JSON.parse(git(['show', `${revision}:package.json`], cwd)), version: undefined })
    if (JSON.stringify(manifest(parent)) !== JSON.stringify(manifest(commit))) problems.push('The release commit changes package.json beyond its version.')
  }
  const recorded = new Map(git(['log', '-1', '--format=%(trailers:key=Clean-Round,valueonly,separator=%x0a)', commit], cwd)
    .split('\n').filter(Boolean).map(value => {
      const [suite, ids = ''] = value.split('=')
      return [suite.trim(), ids.split(',').map(id => id.trim()).filter(Boolean)]
    }))
  if (recorded.has('gate')) {
    problems.push(...await gateRoundProblems(call, workspaceId, recorded.get('gate'), parent))
    return problems
  }
  for (const suite of RELEASE_SUITES) {
    const tickets = recorded.get(suite) ?? []
    if (!tickets.length) { problems.push(`No clean ${suite} round is recorded.`); continue }
    const found = await call('ci_get', { workspaceId, ticketId: tickets[0] }).catch(error => ({ error }))
    if (found.error) { problems.push(`${suite} ticket ${tickets[0]} is unreadable: ${found.error.message}`); continue }
    const group = found.partitions ?? [found.run]
    const ids = group.map(run => run.id)
    if (ids.length !== tickets.length || ids.some(id => !tickets.includes(id))) {
      problems.push(`${suite}: the recorded tickets are not the whole CI group (${ids.join(', ')}).`)
    }
    for (const run of group) {
      const label = `${suite} ticket ${run.id}`
      if (run.suite !== suite) problems.push(`${label} ran the ${run.suite} suite.`)
      if (run.scope !== 'full') problems.push(`${label} ran with ${run.scope} scope, not full.`)
      if (run.commit !== parent) problems.push(`${label} tested ${run.commit}, not the released code ${parent}.`)
      if (run.state !== 'passed') problems.push(`${label} ${run.state}.`)
    }
  }
  return problems
}

/** A gate round is one CI group whose parts cover every release suite; all of them must have passed. */
async function gateRoundProblems(call, workspaceId, tickets, parent) {
  if (!tickets.length) return ['No clean gate round is recorded.']
  const found = await call('ci_get', { workspaceId, ticketId: tickets[0] }).catch(error => ({ error }))
  if (found.error) return [`gate ticket ${tickets[0]} is unreadable: ${found.error.message}`]
  const problems = []
  const group = found.partitions ?? [found.run]
  const ids = group.map(run => run.id)
  if (ids.length !== tickets.length || ids.some(id => !tickets.includes(id))) {
    problems.push(`gate: the recorded tickets are not the whole CI group (${ids.join(', ')}).`)
  }
  for (const run of group) {
    const label = `gate ${run.suite} ticket ${run.id}`
    if (run.gate !== true) problems.push(`${label} is not a gate run.`)
    if (run.scope !== 'full') problems.push(`${label} ran with ${run.scope} scope, not full.`)
    if (run.commit !== parent) problems.push(`${label} tested ${run.commit}, not the released code ${parent}.`)
    if (run.state !== 'passed') problems.push(`${label} ${run.state}.`)
  }
  for (const suite of RELEASE_SUITES) {
    if (!group.some(run => run.suite === suite)) problems.push(`The gate round has no ${suite} part.`)
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [commit] = process.argv.slice(2)
  if (!commit) {
    console.error('usage: node scripts/verify-release-round.mjs <release commit>')
    process.exit(2)
  }
  process.exitCode = await (async () => {
    const call = await mcpClient('verify-release-round')
    const problems = await releaseRoundProblems(call, await workspaceFor(call), git(['rev-parse', commit]))
    for (const problem of problems) console.error(`[release] ${problem}`)
    if (problems.length) { console.error(`[release] ${commit} has no clean round; do not deploy it.`); return 1 }
    console.error(`[release] ${commit} ships code that passed one clean full round.`)
    return 0
  })().catch(error => { console.error(`[release] ${error.message}`); return 1 })
}
