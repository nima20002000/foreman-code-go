import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { groupUsed, integrationProcessProgress, stopGroup, superviseIntegrationProcess,
  waitForIntegrationProcess } from './integration-process.mjs'
import { fullRunExitCode, scheduleFiles } from './test-integration.mjs'

function loggedChild(log, script) {
  const fd = openSync(log, 'w', 0o600)
  try {
    return spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', fd, fd] })
  } finally {
    closeSync(fd)
  }
}

async function waitForLog(log, text) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (readFileSync(log, 'utf8').includes(text)) return
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`Child did not write ${text}`)
}

test('an idle owned group fails, retains its log, and frees the slot for the next file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-'))
  const children = []
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'ignore' })
  const started = []
  const timeouts = []
  const resets = []
  const hangingScript = `
    const { spawn } = require('node:child_process')
    process.on('SIGTERM', () => {})
    const worker = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log('grandchild ready'); setInterval(() => {}, 1000)"
    ], { stdio: 'inherit' })
    console.log('owned grandchild ' + worker.pid)
    setInterval(() => {}, 1000)
  `
  try {
    const result = await scheduleFiles(['hang', 'next'], [{ index: 1 }], async (slot, file) => {
      started.push([slot.index, file])
      const log = join(directory, `${file}.log`)
      const script = file === 'hang' ? hangingScript : "console.log('next file completed')"
      const child = loggedChild(log, script)
      children.push(child)
      if (file === 'hang') await waitForLog(log, 'grandchild ready')
      if (file === 'next') assert.deepEqual(resets, [1], 'reset must finish before the next file starts')
      const outcome = await superviseIntegrationProcess(child, { log, idleTimeoutMs: 300,
        fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100,
        onTimeout: (error) => timeouts.push(error.message),
        resetAfterTimeout: async () => {
          assert.equal(groupUsed(child.pid), false, 'no database callers may survive before reset')
          await new Promise((done) => setTimeout(done, 20))
          resets.push(slot.index)
        },
      })
      assert.equal(groupUsed(child.pid), false, 'a slot must be drained before reuse')
      return outcome
    })
    assert.deepEqual(started, [[1, 'hang'], [1, 'next']])
    assert.deepEqual(result.outcomes.map(({ code }) => code), [124, 0])
    assert.equal(result.skipped, 0)
    assert.equal(timeouts.length, 1)
    assert.match(timeouts[0], /no log output/)
    const saved = readFileSync(join(directory, 'hang.log'), 'utf8')
    assert.match(saved, /grandchild ready/)
    assert.match(saved, /TIMEOUT: no log output/)
    const descendant = Number(saved.match(/owned grandchild (\d+)/)[1])
    if (existsSync(`/proc/${descendant}/stat`)) {
      const status = readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]
      assert.equal(status, 'Z', 'the descendant cannot keep making database calls')
    }
    assert.equal(groupUsed(unrelated.pid), true, 'another process group must remain untouched')
  } finally {
    for (const child of [...children, unrelated]) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed timeout reset retires its slot while the healthy worker executes the remaining queue', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-reset-'))
  const children = []
  const started = []
  const slots = [{ index: 1 }, { index: 2 }]
  const files = ['hang', 'healthy', 'remaining-one', 'remaining-two']
  const resetError = new Error('owned database reset rejected')
  try {
    const result = await scheduleFiles(files, slots, async (slot, file) => {
      if (slot.resetError) throw slot.resetError
      started.push([slot.index, file])
      const log = join(directory, `${file}.log`)
      let script = "console.log('completed')"
      if (file === 'hang') script = "console.log('ready'); setInterval(() => {}, 1000)"
      if (file === 'healthy') {
        script = "console.log('ready'); const timer = setInterval(() => console.log('working'), 50);"
          + "setTimeout(() => { clearInterval(timer); console.log('completed') }, 650)"
      }
      const child = loggedChild(log, script)
      children.push(child)
      if (file === 'hang' || file === 'healthy') await waitForLog(log, 'ready')
      const outcome = await superviseIntegrationProcess(child, { log, idleTimeoutMs: 200,
        fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100,
        resetAfterTimeout: async () => {
          assert.equal(groupUsed(child.pid), false)
          slot.resetError = resetError
          throw resetError
        },
      })
      slot.unavailable = outcome.slotUnavailable
      return outcome
    })
    assert.deepEqual(started, [[1, 'hang'], [2, 'healthy'],
      [2, 'remaining-one'], [2, 'remaining-two']])
    assert.equal(result.skipped, 0)
    assert.deepEqual(result.unexecuted, [])
    const timeout = result.outcomes.find(({ file }) => file === 'hang')
    assert.equal(timeout.code, 124)
    assert.equal(timeout.slotUnavailable, true)
    assert.equal(timeout.resetError, resetError)
    assert.equal(result.outcomes.filter(({ code }) => code === 0).length, 3)
    const saved = readFileSync(join(directory, 'hang.log'), 'utf8')
    assert.match(saved, /TIMEOUT: no log output/)
    assert.match(saved, /database reset rejected/)
    assert.ok(children.every((child) => !groupUsed(child.pid)))
  } finally {
    for (const child of children) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('when every slot is retired, remaining files are identified as unexecuted and the run fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-all-retired-'))
  const children = []
  const files = ['hang-one', 'hang-two', 'unexecuted-one', 'unexecuted-two']
  try {
    const result = await scheduleFiles(files, [{ index: 1 }, { index: 2 }], async (slot, file) => {
      const log = join(directory, `${file}.log`)
      const child = loggedChild(log, "console.log('ready'); setInterval(() => {}, 1000)")
      children.push(child)
      await waitForLog(log, 'ready')
      return superviseIntegrationProcess(child, { log, idleTimeoutMs: 200,
        fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100,
        resetAfterTimeout: async () => {
          assert.equal(groupUsed(child.pid), false)
          throw new Error(`slot ${slot.index} reset failed`)
        },
      })
    })
    assert.equal(result.outcomes.length, 2)
    assert.ok(result.outcomes.every(({ code, slotUnavailable }) => code === 124 && slotUnavailable))
    assert.deepEqual(result.unexecuted, ['unexecuted-one', 'unexecuted-two'])
    assert.equal(fullRunExitCode(result.outcomes.filter(({ code }) => code !== 0).length, null), 1)
    assert.ok(children.every((child) => !groupUsed(child.pid)))
    assert.ok(!existsSync(join(directory, 'unexecuted-one.log')))
    assert.ok(!existsSync(join(directory, 'unexecuted-two.log')))
  } finally {
    for (const child of children) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('continuous log noise cannot defeat the absolute file deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-noise-'))
  const log = join(directory, 'noise.log')
  const child = loggedChild(log, "console.log('ready'); setInterval(() => console.log('still waiting'), 20)")
  try {
    await waitForLog(log, 'ready')
    const outcome = await waitForIntegrationProcess(child, { log, idleTimeoutMs: 100,
      fileTimeoutMs: 300, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(outcome.code, 124)
    assert.equal(outcome.timedOut, true)
    assert.match(outcome.error.message, /file exceeded 300 ms/)
    assert.match(readFileSync(log, 'utf8'), /still waiting/)
    assert.equal(groupUsed(child.pid), false)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a long progressing file survives the idle deadline and its monitor is cleared on exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-progress-'))
  const log = join(directory, 'progress.log')
  const script = `
    console.log('ready')
    const timer = setInterval(() => console.log('case completed'), 20)
    setTimeout(() => { clearInterval(timer); console.log('finished') }, 400)
  `
  const child = loggedChild(log, script)
  try {
    await waitForLog(log, 'ready')
    const progress = integrationProcessProgress()
    const outcome = await waitForIntegrationProcess(child, { log, progress, idleTimeoutMs: 100,
      fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(outcome.code, 0)
    assert.equal(outcome.timedOut, false)
    assert.ok(progress.bytes > 0)
    const lastOutputAt = progress.lastOutputAt
    const bytes = progress.bytes
    appendFileSync(log, 'output after monitor finished\n')
    await new Promise((done) => setTimeout(done, 150))
    assert.equal(progress.lastOutputAt, lastOutputAt)
    assert.equal(progress.bytes, bytes)
    assert.match(readFileSync(log, 'utf8'), /finished/)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('exit'), 0)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a spawn failure clears the deadline and reports a runner failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-spawn-'))
  const log = join(directory, 'spawn.log')
  const fd = openSync(log, 'w', 0o600)
  const child = spawn(join(directory, 'missing-executable'), [], { detached: true,
    stdio: ['ignore', fd, fd] })
  closeSync(fd)
  try {
    const outcome = await waitForIntegrationProcess(child, { log, idleTimeoutMs: 100,
      fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(outcome.code, 1)
    assert.equal(outcome.error.code, 'ENOENT')
    assert.equal(outcome.timedOut, false)
    assert.equal(statSync(log).size, 0)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('exit'), 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('external interruption clears the watchdog without being mislabeled as a timeout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-interrupt-'))
  const log = join(directory, 'interrupt.log')
  const child = loggedChild(log, "console.log('ready'); setInterval(() => {}, 1000)")
  try {
    await waitForLog(log, 'ready')
    const pending = waitForIntegrationProcess(child, { log, idleTimeoutMs: 1000,
      fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100 })
    process.kill(-child.pid, 'SIGINT')
    const outcome = await pending
    assert.equal(outcome.code, 130)
    assert.equal(outcome.timedOut, false)
    assert.doesNotMatch(readFileSync(log, 'utf8'), /TIMEOUT/)
    assert.equal(child.listenerCount('exit'), 0)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})
