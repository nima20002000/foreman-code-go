import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'

async function fixture(t, failure) {
  const computers = [
    { hostRef: { kind: 'device', mainId: 'main', deviceId: 'first' }, ready: true },
    { hostRef: { kind: 'device', mainId: 'main', deviceId: 'second' }, ready: true },
    { hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 }, ready: true },
    { hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 1 }, ready: true },
    { hostRef: { kind: 'cloud', mainId: 'main', provider: 'circleci', slot: 0 }, ready: true },
    { hostRef: { kind: 'main', mainId: 'main' }, ready: false },
  ]
  const admissions = []
  const canceled = []
  let probes = 0
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/health/live') {
      probes++
      if (failure === 'stall' && admissions.length) return
      response.end('{}')
    } else if (request.url.endsWith('/tests')) {
      response.end(JSON.stringify({ tests: { summary: { passed: 1, failed: 0, skipped: 0 },
        files: [{ file: 'apps/api/src/modules/ci-host/ciSmoke.integration.test.ts', tests: [{ status: 'passed' }] }] } }))
    } else if (request.url.endsWith('/computers')) response.end(JSON.stringify({ computers }))
    else if (request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      admissions.push(input)
      if (failure === 'lock' && admissions.length === 2) return
      response.end(JSON.stringify({ ticketId: `ticket-${admissions.length}` }))
    } else if (request.method === 'DELETE') {
      canceled.push(request.url)
      response.end('{}')
    } else {
      const input = admissions[Number(request.url.split('-').at(-1)) - 1]
      const failed = failure === 'setup' && input?.smokeComputer?.deviceId === 'second'
      response.end(JSON.stringify({ run: { state: failed ? 'failed' : 'passed', exitCode: failed ? 1 : 0,
        message: failed ? 'ERR_PNPM_NO_OFFLINE_META: package metadata missing' : null,
        computer: { hostRef: input?.smokeComputer }, files: input?.files },
        logTail: failed ? 'setup failed: ERR_PNPM_NO_OFFLINE_META' : 'one test passed' }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { origin: `http://127.0.0.1:${server.address().port}`, admissions, canceled, computers,
    probes: () => probes }
}

const options = { workspaceId: 'workspace', commit: 'a'.repeat(40), probeDurationMs: 80,
  timeoutMs: 1000, requestTimeoutMs: 60, pollMs: 10 }

test('CI smoke probes repeatedly, makes consecutive admissions and tests each ready executor', async t => {
  const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
  const f = await fixture(t)
  await runInstallCiSmoke({ ...options, origin: f.origin })
  assert.deepEqual(f.admissions.slice(0, 2).map(input => input.files), [[], []])
  assert.notEqual(f.admissions[0].commandId, f.admissions[1].commandId)
  const targets = f.admissions.filter(input => input.smokeComputer)
  assert.deepEqual(targets.map(input => input.smokeComputer),
    [f.computers[0], f.computers[1], f.computers[2], f.computers[4]].map(computer => computer.hostRef))
  assert.ok(targets.every(input => input.files.length === 1 && input.scope === 'affected'))
  assert.ok(f.probes() >= 3)
})

for (const failure of ['setup', 'lock', 'stall']) {
  test(`CI smoke fails closed and cancels its admitted jobs on ${failure}`, async t => {
    const { runInstallCiSmoke } = await import('./install-ci-smoke.mjs')
    const f = await fixture(t, failure)
    const started = Date.now()
    await assert.rejects(runInstallCiSmoke({ ...options, origin: f.origin }),
      failure === 'setup' ? /ERR_PNPM_NO_OFFLINE_META/ : /timed out/)
    assert.ok(Date.now() - started < 1500)
    assert.ok(f.canceled.length > 0)
  })
}
