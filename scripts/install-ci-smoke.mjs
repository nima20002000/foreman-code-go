import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

const smokeFile = 'apps/api/src/modules/ci-host/ciSmoke.integration.test.ts'

function httpClient(origin, signal, timeoutMs) {
  return async (path, options = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      const response = await fetch(`${origin}${path}`, { ...options,
        headers: { origin, 'content-type': 'application/json' },
        signal: AbortSignal.any([signal, timeout]) })
      const body = await response.text()
      if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: HTTP ${response.status}: ${body}`)
      return body ? JSON.parse(body) : {}
    } catch (error) {
      if (timeout.aborted || signal.reason?.name === 'TimeoutError') {
        throw new Error(`${options.method ?? 'GET'} ${path} timed out: ${error.message}`)
      }
      throw error
    }
  }
}

function smokeTargets(computers) {
  const providers = new Set()
  return computers.filter(computer => {
    if (!computer.ready) return false
    if (computer.hostRef.kind !== 'cloud') return true
    if (providers.has(computer.hostRef.provider)) return false
    providers.add(computer.hostRef.provider)
    return true
  })
}

export async function runInstallCiSmoke({ origin, workspaceId, commit, probeDurationMs = 30_000,
  timeoutMs = 165_000, requestTimeoutMs = 5000, pollMs = 1000 }) {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
  const request = httpClient(origin, signal, requestTimeoutMs)
  const root = `/api/management/workspaces/${encodeURIComponent(workspaceId)}/ci`
  const tickets = new Set()
  let ciFinished = false
  const probes = async () => {
    const until = Date.now() + probeDurationMs
    do {
      await request('/health/live')
      await delay(pollMs, undefined, { signal })
    } while (Date.now() < until || !ciFinished)
  }
  const admit = async selection => {
    const result = await request(root, { method: 'POST', body: JSON.stringify({
      suite: selection.smokeComputer ? 'integration' : 'unit', scope: 'affected', commit, commandId: randomUUID(), priority: 'high',
      noSupersede: true, ...selection }) })
    for (const part of result.partitions ?? [result]) tickets.add(part.ticketId)
    if (result.partitions) throw new Error(`CI smoke unexpectedly split into ${result.partitions.length} jobs.`)
    return result.ticketId
  }
  const wait = async (ticketId, computer) => {
    while (true) {
      const result = await request(`${root}/${ticketId}`)
      if (result.run.state === 'passed' && result.run.exitCode === 0) {
        if (computer) {
          if (!isDeepStrictEqual(result.run.computer?.hostRef, computer.hostRef)) {
            throw new Error(`CI smoke ${ticketId} ran on a different computer.`)
          }
          const { tests } = await request(`${root}/${ticketId}/tests`)
          const file = tests?.files.find(file => file.file === smokeFile)
          if (!file?.tests.some(test => test.status === 'passed') || tests.summary.failed !== 0) {
            throw new Error(`CI smoke ${ticketId} passed without running ${smokeFile}.`)
          }
        }
        tickets.delete(ticketId)
        return
      }
      if (['failed', 'canceled', 'lost'].includes(result.run.state)) {
        throw new Error(`CI smoke ${ticketId} (${JSON.stringify(computer?.hostRef)}): `
          + `${result.run.message ?? result.run.state}\n${result.logTail}`)
      }
      await delay(pollMs, undefined, { signal })
    }
  }
  const run = async () => {
    // Use the same HTTP principal and new command IDs to detect a leaked admission lock.
    const first = await admit({ files: [] })
    const second = await admit({ files: [] })
    await wait(first)
    await wait(second)
    const targets = smokeTargets((await request(`${root}/computers`)).computers)
    if (!targets.length) throw new Error('CI smoke has no ready executor. Configure CI or explicitly opt out.')
    const jobs = []
    for (const computer of targets) {
      jobs.push({ computer, ticketId: await admit({ files: [smokeFile], smokeComputer: computer.hostRef }) })
    }
    await Promise.all(jobs.map(({ ticketId, computer }) => wait(ticketId, computer)))
    ciFinished = true
  }
  try {
    await Promise.all([probes(), run()])
  } catch (error) {
    controller.abort(error)
    const cleanup = httpClient(origin, AbortSignal.timeout(3000), 3000)
    await Promise.all([...tickets].map(async ticketId => {
      try { await cleanup(`${root}/${ticketId}`, { method: 'DELETE' }) }
      catch (failure) { console.error(`CI smoke cancellation ${ticketId}: ${failure.message}`) }
    }))
    if (signal.reason?.name === 'TimeoutError') throw new Error(`CI smoke timed out after ${timeoutMs} ms: ${error.message}`)
    throw error
  } finally {
    controller.abort()
  }
}

export async function runProductionCiSmoke({ origin, release }) {
  if (process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE === '1') {
    console.log('CI smoke explicitly skipped (FOREMAN_INSTALL_SKIP_CI_SMOKE=1).')
    return
  }
  const { repository, commit } = JSON.parse(await readFile(join(release, 'ci-smoke.json'), 'utf8'))
  const request = httpClient(origin, AbortSignal.timeout(5000), 5000)
  let cursor
  let workspace
  do {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })
    const page = await request(`/api/management/workspaces?${query}`)
    workspace = page.items.find(item => `${item.workspace.repository?.owner}/${item.workspace.repository?.name}` === repository)
    cursor = page.pageInfo.nextCursor
  } while (!workspace && cursor)
  if (!workspace) throw new Error(`CI smoke requires a configured workspace for ${repository}.`)
  await runInstallCiSmoke({ origin, workspaceId: workspace.workspace.id, commit })
  console.log('CI smoke passed: responsive API, consecutive admissions and every ready executor.')
}
