import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runReleaseCutover } from './local-production-runtime.mjs'

test('migration recovery preserves the last successful write and its command and audit records', async t => {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'production-backup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const release = join(directory, 'candidate')
  const previousRelease = join(directory, 'previous')
  const backupFile = join(directory, 'database.dump')
  let selected = previousRelease
  let running = true
  let data = { workflow: { revision: 1, name: 'Before update' }, commands: [], audit: [] }
  let acceptedWrite
  const steps = {
    pendingMigrations: async () => [3],
    stop: async () => {
      if (running && !acceptedWrite) {
        data = { workflow: { revision: 2, name: 'Saved before shutdown' },
          commands: [{ id: 'save-command', revision: 2 }],
          audit: [{ commandId: 'save-command', action: 'workflow_update' }] }
        acceptedWrite = structuredClone(data)
      }
      running = false
    },
    backup: async archive => { await writeFile(archive, JSON.stringify(data)) },
    migrate: async () => {
      data.workflow.name = 'Incompatible migration'
      throw new Error('Checkpoint setup failed')
    },
    restore: async archive => { data = JSON.parse(await readFile(archive, 'utf8')) },
    activate: async value => { selected = value },
    start: async () => { running = true },
    ready: async value => { assert.equal(selected, value); assert.equal(running, true) },
  }
  await assert.rejects(runReleaseCutover({ release, previousRelease, backupFile,
    stateFile: join(directory, 'deployment.json'), steps }), /Checkpoint setup failed/)
  assert.ok(acceptedWrite)
  assert.deepEqual(data, acceptedWrite)
  assert.equal(selected, previousRelease)
  assert.equal(running, true)
})
