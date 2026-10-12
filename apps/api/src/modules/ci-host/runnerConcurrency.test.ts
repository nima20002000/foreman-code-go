import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const writes = vi.hoisted(() => ({ duringRunningWrite: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    const [path, data, options] = args
    if (writes.duringRunningWrite && typeof data === 'string' && data.startsWith('{')
      && (JSON.parse(data) as { state?: string }).state === 'running') {
      // Pause after opening/truncating the destination, before its JSON bytes are written.
      await actual.writeFile(path, '', options)
      await writes.duringRunningWrite()
      return actual.writeFile(path, data, { mode: 0o600 })
    }
    return actual.writeFile(...args)
  } }
})

function barrier() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { entered, release, pause: async () => {
    enter()
    await released
  } }
}

const fixtures: { root: string; runner: HostCiRunner }[] = []
afterEach(async () => {
  writes.duringRunningWrite = null
  for (const { root, runner } of fixtures.splice(0)) {
    await vi.waitFor(async () => {
      const status = await runner.status()
      if (status.operation !== 'status' || status.runs.some(run => run.state === 'starting')) {
        throw new Error('The launch has not finished.')
      }
      for (const run of status.runs) {
        if (run.state === 'running') await runner.cancel(run.runId)
      }
    }, { interval: 5, timeout: 10_000 })
    await rm(root, { recursive: true, force: true })
  }
})

async function computer(beforeGithub?: () => Promise<void>) {
  const directory = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
    ?? join(homedir(), '.cache/foreman-code/tests')
  await mkdir(directory, { recursive: true })
  const root = await mkdtemp(join(directory, 'host-ci-concurrency-'))
  const ports: HostCiPorts = { cpus: 8, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'gh') await beforeGithub?.()
      if (file === 'git' && args.includes('worktree') && args.includes('add')) {
        const source = args.at(-2)!
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
      }
      return { code: 0, stdout: file === 'systemctl' && args.includes('is-active') ? 'active\n' : '', stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports)
  fixtures.push({ root, runner })
  const request = { operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: 'a'.repeat(40),
    suite: 'lint', scope: 'full' }
  return { runner, request }
}

describe('host CI runner concurrent starts', () => {
  it('admits one start and preserves same-run retries during GitHub preflight', async () => {
    const github = barrier()
    const { runner, request } = await computer(github.pause)
    const first = runner.handle(request)
    await github.entered
    const retry = runner.handle(request)
    const second = runner.handle({ ...request, runId: randomUUID() })
    const rejected = expect(second).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    github.release()
    await expect(first).resolves.toMatchObject({ run: { runId: request.runId } })
    await expect(retry).resolves.toMatchObject({ run: { runId: request.runId } })
    await rejected
  })

  it('keeps the run readable and rejects a second start while launch writes its running state', async () => {
    const writing = barrier()
    const { runner, request } = await computer()
    writes.duringRunningWrite = writing.pause
    try {
      await runner.handle(request)
      await writing.entered
      await expect(runner.handle({ operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 1 }))
        .resolves.toMatchObject({ run: { state: 'starting' } })
      await expect(runner.handle({ ...request, runId: randomUUID() }))
        .rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    } finally {
      writing.release()
    }
  })
})
