import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'
import { readCiSlots } from './planningCapacity.js'
import { CircleRest } from './cloudCircle.js'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import { GitHubRest } from './cloudGithub.js'
import type { CloudHttp } from './cloudHttp.js'
import { DomainError } from '../errors.js'
import { readOperationalFailures } from '../diagnostics/logger.js'
import { packEntries } from '../files/archives/zip.js'
import { Budget } from '../files/archives/policy.js'
import { fixture } from './cloud.testSupport.js'
import { splitUnavailableGateParts } from './gateFallback.js'
import { CiRunRecordSchema } from '@foreman-code/contracts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-observations-'))
  roots.push(root)
  return root
}
const retained: CloudRun = { runId: 'retained', repository: 'example/project', mirror: 'example/mirror',
  commit: 'a'.repeat(40), suite: 'unit', startedAt: '2026-10-14T00:00:00Z', providerRunId: 'pipeline',
  state: 'running', finishedAt: null, exitCode: null, message: null }

it('does not report an estimated ordinary slot as observed capacity', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const capacity = await readCiSlots(pool, { computers: async () => [], request: vi.fn() })
  expect(capacity).toMatchObject({ host: 0, ordinary: 0 })
})

it('rechecks provider readiness after a failed observation and retains its cause', async () => {
  const f = await fixture()
  vi.spyOn(f.cloud.provider, 'ready').mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'EIO' }))
    .mockResolvedValue(true)
  expect(await f.cloud.ready()).toBe(false)
  expect(await f.cloud.ready()).toBe(true)
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'check CI provider readiness',
    lastError: 'EIO', failureCount: 1 }))
})

it('keeps a live output failure visible while preserving the running result', async () => {
  const failure = new DomainError('CI_CLOUD_FAILED', 'Provider output is unavailable', 502)
  const http = { operation: async () => { throw failure } } as unknown as CloudHttp
  expect(await new CircleRest(http).output('job', 0, 100)).toEqual({ ok: false, text: '' })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read CircleCI live output',
    lastError: 'CI_CLOUD_FAILED' }))
})

it('keeps the terminal parent result and reports unavailable job details', async () => {
  const ports: HostCiPorts = { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async (_binary, args) => args[0] === 'run'
      ? { code: 0, stderr: '', stdout: JSON.stringify({ phase: 'ended', outcome: 'succeeded',
        stopped_at: '2026-10-14T00:01:00Z', workflows: [{ phase: 'ended', jobs: [{ id: 'job' }] }] }) }
      : { code: 1, stdout: '', stderr: 'Job details unavailable' } }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  expect(await provider.status(retained)).toMatchObject({ done: true, conclusion: 'success' })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read CircleCI job details' }))
})

it('marks skipped step logs in the returned text', async () => {
  const bytes = await packEntries([{ name: 'Suite/1_First.txt', kind: 'file', bytes: Buffer.from('first\n') }], new Budget())
  const jobs = [{ id: 1, name: 'Suite', conclusion: 'success', steps: [
    { number: 1, name: 'First' }, { number: 2, name: 'Second' },
  ] }]
  const http = { operation: async (_ms: number, work: () => Promise<unknown>) => work(),
    request: async () => Response.json({ jobs }), check: async () => undefined,
    json: async () => ({ jobs }), download: async () => bytes } as unknown as CloudHttp
  const output = await new GitHubRest(http).log('example/mirror', 'pipeline')
  expect(output).toContain('Log unavailable: Suite / Second')
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read GitHub step log' }))
})

it.each(['metadata', 'exit', 'step'])('does not hide an unreadable retained %s file', async area => {
  const root = await directory()
  const runId = randomUUID()
  const run = join(root, 'runs', runId)
  await mkdir(run, { recursive: true })
  await writeFile(join(run, 'meta.json'), JSON.stringify({ ...retained, runId, cleaned: false,
    cancellationRequested: false }))
  if (area === 'metadata') await writeFile(join(run, 'meta.json'), '{invalid')
  else await mkdir(join(run, area))
  const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async binary => ({ code: 0, stdout: binary === 'systemctl' ? 'active\n' : '', stderr: '' }) })
  const request = area === 'metadata' ? { operation: 'status' }
    : { operation: 'read', runId, afterOffset: 0, maxBytes: 100 }
  await expect(runner.handle(request)).rejects.toThrow()
})

it('fails a missing retained cloud log instead of returning empty successful output', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const path = join(f.root, 'ci-cloud', 'runs', runId)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'meta.json'), JSON.stringify({ ...retained, runId, state: 'passed',
    exitCode: 0, finishedAt: '2026-10-14T00:01:00Z', collection: { log: true, artifacts: true } }))
  await expect(f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 })).rejects.toThrow()
})

it('keeps the build-computer reassignment cause on the original ticket', async () => {
  const run = CiRunRecordSchema.parse({ repository: retained.repository, commit: retained.commit, startedAt: null,
    finishedAt: null, exitCode: null, message: null, id: randomUUID(), groupId: randomUUID(),
    workspaceId: 'workspace', gate: true, suite: 'integration', state: 'queued', computer: null,
    queuedAt: '2026-10-13T00:00:00Z', plannedHostKey: 'fixture-build', step: null, partition: null,
    files: ['apps/api/test/feature.integration.test.ts'],
    initiator: { principalId: 'operator', executionId: null } })
  const query = async () => ({ rows: [], rowCount: 1 })
  const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool
  const cloud = { key: 'fixture-cloud', label: 'Fixture cloud', priority: 1,
    hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot: 0 } }
  const parts = await splitUnavailableGateParts(pool, [run], { computers: [cloud],
    shards: new Map([[cloud.key, 1]]), durations: new Map(), reservedCloud: new Set(), gate: undefined,
    canTake: () => true, idle: () => true, freeSlots: () => 1 })
  expect(parts[0]).toMatchObject({ id: run.id, message: expect.stringMatching(/unavailable.*reassigned/i) })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'reassign unavailable CI build part' }))
})
