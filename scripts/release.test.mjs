import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const releaseScript = new URL('./release.mjs', import.meta.url).pathname
const verifyScript = new URL('./verify-release-round.mjs', import.meta.url).pathname
const workspaceId = 'workspace-release-test'

/** A Main whose CI finishes every run at once; `outcome(run)` picks each run's final state. */
async function fakeMain(t, outcome = () => 'passed') {
  const runs = new Map(), groups = new Map(), calls = [], commands = new Map()
  const tools = {
    ci_run: input => {
      // Like Main, a repeated commandId returns the original tickets instead of starting new ones.
      if (input.commandId && commands.has(input.commandId)) return commands.get(input.commandId)
      const { suite, commit, scope, partitions, gate } = input
      const groupId = randomUUID()
      // A gate is one group with typecheck, lint, unit and integration parts.
      const suites = gate ? ['typecheck', 'typecheck', 'lint', 'lint', 'unit', 'unit', 'unit', 'integration', 'integration', 'integration']
        : Array.from({ length: partitions ?? (suite === 'unit' ? 2 : 1) }, () => suite)
      const count = suites.length
      const group = suites.map((value, index) => ({ id: randomUUID(), workspaceId, suite: value, commit,
        scope: scope ?? 'affected', groupId, part: null, partition: count > 1 ? { index, count } : null, computer: null,
        message: null, ...(gate ? { gate: true } : {}) }))
      for (const run of group) runs.set(run.id, { ...run, state: outcome(run) })
      groups.set(groupId, group.map(run => run.id))
      const reply = count > 1 ? { ticketId: group[0].id, partitions: group.map(run => ({ ticketId: run.id })) } : { ticketId: group[0].id }
      if (input.commandId) commands.set(input.commandId, reply)
      return reply
    },
    ci_get: ({ ticketId, testStatus }) => {
      const run = runs.get(ticketId)
      if (!run) throw new Error('Unknown ticket.')
      const group = groups.get(run.groupId).map(id => runs.get(id))
      return { run, logTail: '', partitions: group.length > 1 ? group : undefined,
        ...(testStatus ? { tests: run.state === 'failed'
          ? { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [{ file: 'apps/api/src/broken.test.ts',
            status: 'failed', durationMs: 1, tests: [{ name: 'breaks on purpose', status: 'failed', durationMs: 1 }] }] }
          : null } : {}) }
    },
    ci_logs_read: () => ({ text: 'FAIL apps/api/src/broken.test.ts\n', nextOffset: 0 }),
  }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const { id, method, params } = JSON.parse(body)
    const reply = result => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id, result })) }
    if (request.headers.authorization !== 'Bearer release-test-token') { response.statusCode = 401; return reply(undefined) }
    if (method === 'initialize') return reply({ protocolVersion: '2025-11-25' })
    calls.push({ name: params.name, arguments: params.arguments })
    try { reply({ content: [{ type: 'text', text: JSON.stringify(tools[params.name](params.arguments)) }] }) }
    catch (error) { reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ message: error.message }) }] }) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, runs, calls, groups }
}

function repository(t) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com' }
  const work = join(root, 'work'), origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim()
  writeFileSync(join(work, 'package.json'), '{\n  "name": "app",\n  "version": "1.0.0"\n}\n')
  writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A fix.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n')
  git('add', '.'); git('commit', '-qm', 'first'); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main')
  return { work, git, env }
}

function run(script, args, cwd, main, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...env, FOREMAN_CODE_MAIN_URL: main.url,
      FOREMAN_CODE_OPERATOR_TOKEN: 'release-test-token', FOREMAN_CODE_WORKSPACE_ID: workspaceId, FOREMAN_CODE_CI_PARTITIONS: '3' } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('exit', status => resolve({ status, output }))
  })
}

test('a clean gate releases HEAD with every gate ticket recorded and pushes it', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 0, result.output)
  const started = main.calls.filter(call => call.name === 'ci_run').map(call => call.arguments)
  assert.deepEqual(started.map(value => [value.suite, value.scope, value.commit, value.gate, value.priority, value.commandId]),
    [['integration', 'full', tested, true, 'high', `gate-${tested}`]])
  assert.equal(git('log', '-1', '--format=%s'), 'Release v1.1.0')
  assert.equal(git('rev-parse', 'HEAD^'), tested)
  assert.equal(git('rev-parse', 'origin/main'), git('rev-parse', 'HEAD'))
  const trailers = git('log', '-1', '--format=%(trailers:key=Clean-Round,valueonly,separator=%x0a)').split('\n')
  assert.equal(trailers.length, 1)
  const [label, ids] = trailers[0].split('=')
  assert.equal(label, 'gate')
  assert.deepEqual(new Set(ids.split(',').map(id => main.runs.get(id).suite)), new Set(['typecheck', 'lint', 'unit', 'integration']))
  assert.equal(ids.split(',').length, 10)
  assert.equal(JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version, '1.1.0')
  assert.match(readFileSync(join(work, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n## \[1\.1\.0\] - \d{4}-\d{2}-\d{2}\n\n### Fixed\n\n- A fix\.\n\n## \[1\.0\.0\]/)

  const verified = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(verified.status, 0, verified.output)
})

test('a release reuses the gate that already passed on HEAD instead of running another round', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  // The gate line already gated this commit with the canonical commandId.
  const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
      workspaceId, commit: tested, suite: 'integration', scope: 'full', gate: true, priority: 'high', commandId: `gate-${tested}` } } }) })
  const earlier = JSON.parse((await response.json()).result.content[0].text)
  const groupsBefore = main.groups.size
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 0, result.output)
  assert.equal(main.groups.size, groupsBefore)
  const trailer = git('log', '-1', '--format=%(trailers:key=Clean-Round,valueonly)')
  assert.deepEqual(trailer.split('=')[1].split(',').sort(), earlier.partitions.map(value => value.ticketId).sort())
  const verified = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(verified.status, 0, verified.output)
})

test('the verifier rejects a gate round with a missing ticket, a missing suite or a non-gate part', async t => {
  const main = await fakeMain(t)
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  const start = async input => {
    const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
        workspaceId, commit: tested, scope: 'full', ...input } } }) })
    const started = JSON.parse((await response.json()).result.content[0].text)
    return (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId)
  }
  const gate = await start({ suite: 'integration', gate: true, commandId: `gate-${tested}` })
  releaseCommit(git, work, [['gate', gate.slice(1)]])
  let result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /gate: the recorded tickets are not the whole CI group/)

  git('reset', '-q', '--hard', tested)
  const integration = await start({ suite: 'integration', partitions: 2 })
  releaseCommit(git, work, [['gate', integration]])
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /is not a gate run/)
  assert.match(result.output, /gate round has no typecheck part/)
})

test('one failed partition prints its ticket and test and creates no release', async t => {
  let integrationParts = 0
  const main = await fakeMain(t, run => run.suite === 'integration' && ++integrationParts === 2 ? 'failed' : 'passed')
  const { work, git, env } = repository(t)
  const head = git('rev-parse', 'HEAD')
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 1)
  const failed = [...main.runs.values()].find(value => value.state === 'failed')
  assert.match(result.output, new RegExp(`integration ticket ${failed.id} failed`))
  assert.match(result.output, /failed test apps\/api\/src\/broken\.test\.ts > breaks on purpose/)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('ls-remote', 'origin', 'main').split(/\s/)[0], head)
  assert.equal(git('status', '--porcelain'), '')
})

test('refuses to release from a dirty worktree without starting CI', async t => {
  const main = await fakeMain(t)
  const { work, env } = repository(t)
  writeFileSync(join(work, 'package.json'), '{}\n')
  const result = await run(releaseScript, ['1.1.0'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /uncommitted changes/)
  assert.equal(main.calls.length, 0)
})

/** A release commit on top of the tested code whose trailers list the given groups. */
function releaseCommit(git, work, groups) {
  writeFileSync(join(work, 'package.json'), '{\n  "name": "app",\n  "version": "1.1.0"\n}\n')
  git('commit', '-qam', 'Release v1.1.0', '-m', groups.map(([suite, ids]) => `Clean-Round: ${suite}=${ids.join(',')}`).join('\n'))
}

test('the verifier rejects a release with no recorded round, a failed part or affected scope', async t => {
  const outcomes = new Map()
  const main = await fakeMain(t, run => outcomes.get(run.suite) ?? 'passed')
  const { work, git, env } = repository(t)
  const tested = git('rev-parse', 'HEAD')
  const round = async (scope) => {
    const groups = []
    for (const suite of ['typecheck', 'lint', 'unit', 'integration']) {
      const response = await fetch(`${main.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer release-test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run', arguments: {
          workspaceId, suite, commit: tested, scope, ...(suite === 'integration' ? { partitions: 2 } : {}) } } }) })
      const started = JSON.parse((await response.json()).result.content[0].text)
      groups.push([suite, (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId)])
    }
    return groups
  }

  releaseCommit(git, work, [])
  let result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /No clean typecheck round is recorded/)

  git('reset', '-q', '--hard', tested)
  releaseCommit(git, work, await round('affected'))
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /affected scope, not full/)

  git('reset', '-q', '--hard', tested)
  outcomes.set('lint', 'failed')
  releaseCommit(git, work, await round('full'))
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /lint ticket \S+ failed/)

  git('reset', '-q', '--hard', tested)
  outcomes.clear()
  const groups = await round('full')
  releaseCommit(git, work, groups.map(([suite, ids]) => [suite, suite === 'integration' ? ids.slice(1) : ids]))
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /integration: the recorded tickets are not the whole CI group/)

  git('reset', '-q', '--hard', tested)
  writeFileSync(join(work, 'code.js'), 'untested\n'); git('add', 'code.js')
  releaseCommit(git, work, groups)
  result = await run(verifyScript, ['HEAD'], work, main, env)
  assert.equal(result.status, 1)
  assert.match(result.output, /changes code beyond the version and changelog: code\.js/)
})
