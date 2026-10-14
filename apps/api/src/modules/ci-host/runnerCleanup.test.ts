import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-cleanup-'))
  roots.push(root)
  const ports: HostCiPorts = { cpus: 8, memoryBytes: 16 * 2 ** 30,
    now: () => new Date('2026-10-14T00:00:00Z'),
    run: async () => ({ code: 0, stdout: 'active', stderr: '' }) }
  return { root, runner: new HostCiRunner(root, ports, {}) }
}

async function run(root: string, options: { state?: string; cleaned?: boolean; repository?: string } = {}) {
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId,
    repository: options.repository ?? 'fixture/site', commit: 'a'.repeat(40), suite: 'lint',
    state: options.state ?? 'passed', cleaned: options.cleaned ?? false, partition: null,
    startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z', exitCode: 0, message: null }))
  await writeFile(join(directory, 'log'), 'retained log')
  for (const name of ['src', 'tmp', 'vitest-cache']) {
    await mkdir(join(directory, name), { recursive: true })
    await writeFile(join(directory, name, 'contents'), 'fixture bytes')
  }
  return { runId, directory }
}

it.each([false, true])('removes settled per-run caches on read, including cleaned=%s', async cleaned => {
  const f = await fixture()
  const ticket = await run(f.root, { cleaned })
  await expect(f.runner.handle({ operation: 'read', runId: ticket.runId, afterOffset: 0, maxBytes: 100 }))
    .resolves.toMatchObject({ run: { state: 'passed' }, text: 'retained log' })
  await expect(access(join(ticket.directory, 'vitest-cache'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(ticket.directory, 'log'), 'utf8')).resolves.toBe('retained log')
})

it('retains active per-run and shared caches, then retires the shared cache after the run settles', async () => {
  const f = await fixture()
  const ticket = await run(f.root, { state: 'running' })
  const shared = join(f.root, 'vitest-cache')
  await mkdir(shared)
  await writeFile(join(shared, 'contents'), 'shared bytes')
  await f.runner.handle({ operation: 'status' })
  await expect(readFile(join(shared, 'contents'), 'utf8')).resolves.toBe('shared bytes')
  await expect(access(join(ticket.directory, 'vitest-cache'))).resolves.toBeUndefined()
  await writeFile(join(ticket.directory, 'exit'), '0\n')
  await f.runner.handle({ operation: 'status' })
  await expect(access(shared)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('deletes only DB-selected terminal directories and preserves active and unknown runs', async () => {
  const f = await fixture()
  const terminal = await run(f.root)
  const active = await run(f.root, { state: 'running' })
  const unknown = await run(f.root)
  const reply = await f.runner.handle({ operation: 'status', cleanupRunIds: [terminal.runId, active.runId] })
  expect(reply).toMatchObject({ operation: 'status', removedRunIds: [terminal.runId] })
  await expect(access(terminal.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(active.directory)).resolves.toBeUndefined()
  await expect(access(unknown.directory)).resolves.toBeUndefined()
  await expect(f.runner.handle({ operation: 'status', cleanupRunIds: [terminal.runId] }))
    .resolves.toMatchObject({ operation: 'status', removedRunIds: [] })
})

async function sparseFile(path: string, size: number, usedAt: string) {
  await mkdir(join(path, '..'), { recursive: true })
  const handle = await open(path, 'w')
  try { await handle.truncate(size) } finally { await handle.close() }
  await utimes(path, new Date(usedAt), new Date(usedAt))
}

it('evicts the least recently used cache entries above 3 GB while preserving active repositories', async () => {
  const f = await fixture()
  await run(f.root, { state: 'running', repository: 'fixture/busy' })
  const oldest = join(f.root, 'cache/fixture/idle/pnpm-store/old')
  const newest = join(f.root, 'cache/fixture/idle/pnpm-store/new')
  const busy = join(f.root, 'cache/fixture/busy/pnpm-store/held')
  await sparseFile(oldest, 2 ** 30, '2026-10-01T00:00:00Z')
  await sparseFile(newest, 2 ** 30, '2026-10-03T00:00:00Z')
  await sparseFile(busy, 2 * 2 ** 30, '2026-09-01T00:00:00Z')
  await f.runner.handle({ operation: 'status' })
  await expect(access(oldest)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(newest)).resolves.toBeUndefined()
  await expect(access(busy)).resolves.toBeUndefined()
})
