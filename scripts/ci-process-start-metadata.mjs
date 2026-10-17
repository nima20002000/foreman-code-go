import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForOwnedProcessesToExit } from '../conformance/src/runtime/owned-processes.ts'
const root = await mkdtemp(join(tmpdir(), 'foreman-process-start-'))
const facts = { source: '9e2e8e5f743f4a8bb17bbfde164db5f198e2bae2', testsExecuted: 0,
  changesToProcesses: false, launcherPid: process.pid }
async function startTicks(path, expectedPid) {
  const text = await readFile(path, 'utf8')
  const separator = text.lastIndexOf(')')
  const pid = /^([1-9][0-9]*) \(/.exec(text)?.[1]
  const ticks = text.slice(separator + 1).trim().split(/\s+/)[19]
  if (separator < 0 || pid !== String(expectedPid) || !/^[0-9]+$/.test(ticks ?? '')) {
    throw new Error('Process start metadata was not valid')
  }
  return ticks
}
try {
  try {
    await waitForOwnedProcessesToExit(root, 0)
    facts.originalOutcome = 'returned-with-no-owned-processes'
  } catch (error) {
    facts.originalOutcome = 'threw'
    facts.originalError = { name: error.name, message: error.message, causeCode: error.cause?.code }
    const pid = /^Could not establish process ([1-9][0-9]*) cleanup ownership$/.exec(error.message)?.[1]
    if (pid) {
      facts.failedPid = Number(pid)
      facts.observedAt = new Date().toISOString()
      try {
        facts.failedProcessStartTicks = await startTicks(`/proc/${pid}/stat`, Number(pid))
        facts.launcherStartTicks = await startTicks('/proc/self/stat', process.pid)
        facts.failedProcessStrictlyOlder = BigInt(facts.failedProcessStartTicks) < BigInt(facts.launcherStartTicks)
      } catch (observedError) { facts.metadataError = observedError.code ?? observedError.message }
    }
  }
  console.log('[process-start-observation] ' + JSON.stringify(facts))
} finally { await rm(root, { recursive: true, force: true }) }
