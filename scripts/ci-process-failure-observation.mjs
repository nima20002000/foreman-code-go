import { lstat, stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForOwnedProcessesToExit } from '../conformance/src/runtime/owned-processes.ts'
const root = await mkdtemp(join(tmpdir(), 'foreman-process-metadata-'))
const facts = { source: '9e2e8e5f743f4a8bb17bbfde164db5f198e2bae2',
  currentUid: process.getuid(), observations: [], testsExecuted: 0, changesToProcesses: false }
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
      for (const [name, path, observe] of [
        ['process-directory', `/proc/${pid}`, stat],
        ['cwd-link', `/proc/${pid}/cwd`, lstat],
        ['environ-entry', `/proc/${pid}/environ`, lstat],
      ]) {
        try {
          const info = await observe(path)
          facts.observations.push({ name, uid: info.uid, mode: info.mode & 0o777,
            symbolicLink: info.isSymbolicLink(), directory: info.isDirectory() })
        } catch (observedError) { facts.observations.push({ name, errorCode: observedError.code }) }
      }
    }
  }
  console.log('[failure-site-process-observation] ' + JSON.stringify(facts))
} finally { await rm(root, { recursive: true, force: true }) }
