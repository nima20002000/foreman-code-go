import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeProcessRegistry } from './processRegistry.js'
import { privateDirectory, readRecord, writeRecord } from './storage.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'native-retention-'))
  roots.push(root)
  privateDirectory(root)
  return root
}

function archive(root: string, owner: string, age: number) {
  const ownerKey = createHash('sha256').update(owner).digest('hex')
  const launchId = randomUUID()
  const observation = { owner, launchId, bootId: 'previous-boot', lifecycle: 'closed',
    closureEvidence: 'linux_boot_changed' }
  const directory = privateDirectory(join(root, 'closed'))
  const path = join(directory, `${ownerKey}-${launchId}.json`)
  writeFileSync(path, JSON.stringify(observation), { mode: 0o600 })
  const modified = new Date(Date.now() - age)
  utimesSync(path, modified, modified)
  return { path, observation }
}

it('keeps historical closed owners out of recovery snapshots while retaining direct closure readback', () => {
  const root = fixture()
  const closed = archive(root, 'execution:finished', 2 * 86_400_000)
  const key = createHash('sha256').update(closed.observation.owner).digest('hex')
  writeRecord(join(root, 'closed', `${key}.json`), {
    format: 2, owner: closed.observation.owner, id: closed.observation.launchId, observation: closed.observation,
  })
  const registry = new NativeProcessRegistry(root)
  expect(registry.snapshot().launches).toEqual([])
  expect(registry.closedRegistration(closed.observation.owner, closed.observation.launchId)).toEqual(closed.observation)
})

it('deletes only old settled closures, keeps fresh and unsettled closures, and bounds each sweep', async () => {
  const root = fixture()
  const old = Array.from({ length: 105 }, (_, index) => archive(root, `execution:finished-${index}`, 2 * 86_400_000))
  const pending = archive(root, 'execution:unsettled', 2 * 86_400_000)
  const fresh = archive(root, 'execution:fresh', 60_000)
  const registry = new NativeProcessRegistry(root)
  const checked: string[] = []
  const settled = async (owner: string) => {
    checked.push(owner)
    return owner !== pending.observation.owner
  }
  const first = await registry.pruneSettled(settled)
  expect(first).toBeGreaterThan(0)
  expect(first).toBeLessThanOrEqual(100)
  expect(checked.length).toBeLessThanOrEqual(100)
  expect(readdirSync(join(root, 'closed')).length).toBeGreaterThanOrEqual(7)
  await registry.pruneSettled(settled)
  expect(old.every(record => readRecord(record.path) === undefined)).toBe(true)
  expect(readRecord(pending.path)).toEqual(pending.observation)
  expect(readRecord(fresh.path)).toEqual(fresh.observation)
})

it('retains closure certificates when settlement lookup fails', async () => {
  const root = fixture()
  const closed = archive(root, 'execution:unavailable', 2 * 86_400_000)
  const registry = new NativeProcessRegistry(root)
  await expect(registry.pruneSettled(async () => { throw new Error('journal unavailable') }))
    .rejects.toThrow('journal unavailable')
  expect(readRecord(closed.path)).toEqual(closed.observation)
})
