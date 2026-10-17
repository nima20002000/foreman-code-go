import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { waitForOwnedProcessesToExit } from './owned-processes.js'

it('retains an owned detached process as a cleanup failure until that exact child exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foreman-process-observation-'))
  const owned = join(directory, 'owned')
  const nested = join(owned, 'native')
  const sibling = join(directory, 'owned-other')
  await mkdir(nested, { recursive: true, mode: 0o700 })
  await mkdir(sibling, { mode: 0o700 })
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], {
    cwd: nested, env: {}, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const exited = once(child, 'exit')
  try {
    await once(child, 'message')
    await expect(waitForOwnedProcessesToExit(owned, 0)).rejects.toThrow(
      `Owned conformance processes remain after shutdown: ${child.pid}`,
    )
    await expect(waitForOwnedProcessesToExit(sibling, 0)).resolves.toBeUndefined()
    expect(child.exitCode).toBeNull()
    child.kill('SIGTERM')
    await exited
    await expect(waitForOwnedProcessesToExit(owned, 0)).resolves.toBeUndefined()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
    await rm(directory, { recursive: true })
  }
})
